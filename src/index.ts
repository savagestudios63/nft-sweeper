import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { SweeperDB } from "./db.js";
import { Executor } from "./executor/index.js";
import { JitoSender } from "./executor/jito.js";
import { MagicEdenFeed } from "./feeds/magiceden.js";
import { TensorFeed } from "./feeds/tensor.js";
import { makeLogger } from "./logger.js";
import { PricingEngine } from "./pricing.js";
import { RiskManager } from "./risk.js";
import { RuleEngine } from "./rules.js";
import type { Listing } from "./types.js";
import { loadKeypair } from "./wallet.js";
import { currentSessionId, isPausedOnDisk } from "./control.js";

export async function run(configPath = "./config.yaml") {
  const cfg = loadConfig(configPath);
  const log = makeLogger(cfg.logging.level);
  const db = new SweeperDB(cfg.logging.dbPath);
  const sessionId = currentSessionId();
  const payer = loadKeypair(cfg.wallet.keypairPath);

  log.info({ wallet: payer.publicKey.toBase58(), sessionId }, "sweeper starting");

  const rpc = new Connection(cfg.rpc.url, {
    commitment: cfg.rpc.commitment,
    wsEndpoint: cfg.rpc.ws,
  });

  const jito = new JitoSender(cfg.jito, rpc, payer, cfg.rpc.commitment, log);
  const executor = new Executor(cfg, rpc, payer, jito, log);
  const pricing = new PricingEngine(cfg.pricing.rarityCurve, cfg.pricing.floorStaleMs);
  const rules = RuleEngine.fromConfig(cfg.collections);

  const risk = new RiskManager(cfg, db, sessionId, async () => {
    const bal = await rpc.getBalance(payer.publicKey);
    return bal / LAMPORTS_PER_SOL;
  });

  // Seed per-collection max rank (used by pricing's fair-value math)
  for (const c of cfg.collections) {
    if (c.rarity?.maxRank != null) {
      // We prime with 0 until feeds report actual floor.
      if (c.magicedenSlug) pricing.updateFloor(c.magicedenSlug, 0, c.rarity.maxRank);
      if (c.tensorSlug) pricing.updateFloor(c.tensorSlug, 0, c.rarity.maxRank);
    }
  }

  const meSlugs = cfg.collections.map((c) => c.magicedenSlug).filter((s): s is string => !!s);
  const tnSlugs = cfg.collections.map((c) => c.tensorSlug).filter((s): s is string => !!s);

  const meFeed = new MagicEdenFeed(
    cfg.feeds.magiceden,
    meSlugs,
    log.child({ feed: "me" }),
    (l) => void handleListing(l),
    (slug, floor) => {
      const rule = cfg.collections.find((c) => c.magicedenSlug === slug);
      pricing.updateFloor(slug, floor, rule?.rarity?.maxRank);
    },
  );

  const tnFeed = new TensorFeed(
    cfg.feeds.tensor,
    tnSlugs,
    log.child({ feed: "tensor" }),
    (l) => void handleListing(l),
    (slug, floor) => {
      const rule = cfg.collections.find((c) => c.tensorSlug === slug);
      pricing.updateFloor(slug, floor, rule?.rarity?.maxRank);
    },
  );

  async function handleListing(listing: Listing) {
    if (isPausedOnDisk()) risk.pause();
    else risk.resume();

    const floor = pricing.getFloor(listing.collectionSlug);
    const fair = pricing.fairValue(listing);
    const spread = pricing.spreadPct(listing);
    const sessionSpent = risk.sessionSpendFor(
      `${listing.source}:${listing.collectionSlug}`,
    );

    const outcome = rules.evaluate(listing, {
      floorSol: floor,
      fairValueSol: fair,
      spreadPct: spread,
      minSpreadPct: cfg.pricing.minSpreadPct,
      sessionSpentSol: sessionSpent,
    });

    db.logConsidered({
      listing,
      floorSol: floor,
      fairValueSol: fair,
      matched: outcome.matched,
      reason: outcome.reason,
    });

    if (!outcome.matched) {
      log.debug({ mint: listing.mint, reason: outcome.reason }, "skip");
      return;
    }

    const verdict = await risk.canBuy(listing.priceSol);
    if (!verdict.ok) {
      log.warn({ mint: listing.mint, reason: verdict.reason }, "risk blocked");
      db.logExecuted(
        { listing, success: false, costSol: 0, landedAt: Date.now(), error: verdict.reason },
        0,
        `risk_block: ${verdict.reason}`,
      );
      return;
    }

    risk.beginBuy();
    try {
      log.info(
        {
          mint: listing.mint,
          price: listing.priceSol,
          floor,
          fair,
          spread,
          source: listing.source,
        },
        "sniping",
      );
      const contention = Math.min(1, Math.max(0, spread ? spread / 40 : 0));
      const res = await executor.buy(listing, contention);
      const tip = jito.currentTipLamports(contention);
      db.logExecuted(res, tip, outcome.reason);

      if (res.success) {
        risk.recordSpend(
          `${listing.source}:${listing.collectionSlug}`,
          listing.priceSol,
        );
        if (cfg.postBuy.autoRelist) {
          const relistPriceSol =
            listing.priceSol * (1 + cfg.postBuy.relistMarkupPct / 100);
          log.info({ mint: listing.mint, relistPriceSol }, "auto-relist");
          const r = await executor.relist(listing, relistPriceSol);
          if (r.success) db.recordRelist(listing.mint, relistPriceSol);
        }
      } else {
        log.warn({ mint: listing.mint, error: res.error }, "buy failed");
      }
    } finally {
      risk.endBuy();
    }
  }

  await Promise.all([meFeed.start(), tnFeed.start()]);

  const shutdown = () => {
    log.info("shutting down");
    meFeed.stop();
    tnFeed.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Allow `bun run src/index.ts` to boot directly.
if (import.meta.main) {
  const cfgPath = process.argv[2] ?? "./config.yaml";
  run(cfgPath).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
