import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Listing, Trait } from "../types.js";

export type ListingHandler = (l: Listing) => void;

const ME_API = "https://api-mainnet.magiceden.dev/v2";

export class MagicEdenFeed {
  private ws?: WebSocket;
  private polling = new Map<string, NodeJS.Timeout>();
  private seen = new Set<string>();
  private stopping = false;

  constructor(
    private readonly cfg: Config["feeds"]["magiceden"],
    private readonly slugs: string[],
    private readonly log: Logger,
    private readonly onListing: ListingHandler,
    private readonly onFloor: (slug: string, floorSol: number) => void,
  ) {}

  async start() {
    if (!this.cfg.enabled || this.slugs.length === 0) return;
    this.log.info({ slugs: this.slugs }, "MagicEden feed starting");
    if (this.cfg.wsUrl) {
      try {
        await this.connectWs();
        return;
      } catch (err) {
        this.log.warn({ err }, "ME WS failed, falling back to polling");
      }
    }
    this.startPolling();
  }

  stop() {
    this.stopping = true;
    this.ws?.close();
    for (const t of this.polling.values()) clearInterval(t);
    this.polling.clear();
  }

  private connectWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.cfg.apiKey) headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
      const ws = new WebSocket(this.cfg.wsUrl!, { headers });
      this.ws = ws;

      ws.once("open", () => {
        this.log.info("ME WS open");
        for (const slug of this.slugs) {
          ws.send(
            JSON.stringify({
              type: "subscribe",
              channel: "collection.listings",
              collection: slug,
            }),
          );
        }
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(msg);
        } catch (err) {
          this.log.debug({ err }, "ME WS parse error");
        }
      });

      ws.once("error", (err) => reject(err));
      ws.once("close", () => {
        if (this.stopping) return;
        this.log.warn("ME WS closed, reconnecting in 3s");
        setTimeout(() => this.connectWs().catch(() => this.startPolling()), 3000);
      });
    });
  }

  private handleWsMessage(msg: any) {
    // Shape varies; we defensively pick common fields.
    if (msg?.type === "listing" || msg?.event === "listing") {
      const listing = this.normalizeRaw(msg.data ?? msg.listing ?? msg);
      if (listing) this.emit(listing);
    }
    if (msg?.type === "floor" && msg.collection && msg.floorPrice) {
      this.onFloor(msg.collection, Number(msg.floorPrice) / 1e9);
    }
  }

  private startPolling() {
    for (const slug of this.slugs) {
      const tick = async () => {
        if (this.stopping) return;
        try {
          await this.pollOnce(slug);
        } catch (err) {
          this.log.debug({ err, slug }, "ME poll error");
        }
      };
      const t = setInterval(tick, this.cfg.pollIntervalMs);
      this.polling.set(slug, t);
      void tick();
    }
  }

  private async pollOnce(slug: string) {
    const url = `${ME_API}/collections/${slug}/listings?offset=0&limit=30`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cfg.apiKey) headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      this.log.debug({ slug, status: res.status }, "ME REST non-ok");
      return;
    }
    const rows = (await res.json()) as any[];
    if (!Array.isArray(rows)) return;

    let minPrice = Infinity;
    for (const r of rows) {
      const listing = this.normalizeRaw(r, slug);
      if (!listing) continue;
      if (listing.priceSol < minPrice) minPrice = listing.priceSol;
      this.emit(listing);
    }
    if (Number.isFinite(minPrice)) this.onFloor(slug, minPrice);
  }

  private normalizeRaw(r: any, slugHint?: string): Listing | null {
    if (!r) return null;
    const priceLamports = r.price ?? r.priceInfo?.solPrice?.rawAmount ?? r.priceInLamports;
    const priceSol =
      typeof r.price === "number" && r.price < 1e6 // already in SOL
        ? r.price
        : typeof priceLamports === "number"
          ? priceLamports / 1e9
          : typeof priceLamports === "string"
            ? Number(priceLamports) / 1e9
            : NaN;
    const mint = r.tokenMint ?? r.mintAddress ?? r.mint;
    const seller = r.seller ?? r.sellerFeePayer ?? r.owner;
    const slug = r.collection ?? r.collectionSymbol ?? slugHint;
    if (!mint || !seller || !slug || !Number.isFinite(priceSol)) return null;

    const traits: Trait[] | undefined = Array.isArray(r.attributes)
      ? r.attributes
          .filter((a: any) => a?.trait_type && a?.value != null)
          .map((a: any) => ({ name: String(a.trait_type), value: String(a.value) }))
      : undefined;

    return {
      source: "magiceden",
      mint,
      tokenName: r.title ?? r.name,
      collectionSlug: slug,
      priceSol,
      seller,
      listedAt: r.listedAt ? Date.parse(r.listedAt) : Date.now(),
      rank: typeof r.rarity?.howRare === "number" ? r.rarity.howRare : r.moonRank?.rank,
      traits,
      raw: r,
    };
  }

  private emit(l: Listing) {
    const key = `${l.mint}:${l.priceSol}:${l.seller}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 10_000) this.seen.clear();
    this.onListing(l);
  }
}
