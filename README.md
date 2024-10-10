# nft-sweeper

A Solana NFT floor sniper for Magic Eden and Tensor, written in TypeScript on Bun.

Watches a configured watchlist, computes a rarity-adjusted fair value per listing, submits direct marketplace-program buys via Jito bundles with an adaptive tip, and optionally auto-relists at a markup.

---

## Setup

```bash
bun install
cp config.example.yaml config.yaml
# edit config.yaml — set RPC, wallet path, Tensor API key, collections
```

Export your wallet keypair as a JSON array (same format `solana-keygen` uses) at the path you set in `config.yaml`:

```bash
solana-keygen new -o wallet.json
# fund the wallet, then...
bun run start
```

### CLI

```bash
bun run cli start                 # start the sniper (uses ./config.yaml)
bun run cli start --fresh         # reset per-collection session budgets first
bun run cli pause                 # block further buys (hot — no restart needed)
bun run cli resume                # clear the pause
bun run cli stats                 # aggregate stats from SQLite
bun run cli history -n 50         # last 50 executed snipes
```

### Dry run

Set `risk.dryRun: true` in the config. The bot will log matches and build instructions but never sign or submit. Use this first.

---

## How it works

```
 feeds → normalize → pricing + rules → risk gate → executor → Jito → SQLite
```

1. **Feeds** (`src/feeds/`) subscribe to new listings. Magic Eden tries WSS, falls back to REST polling. Tensor uses the GraphQL WS subscription. Both normalize to a shared `Listing` shape.
2. **Pricing** (`src/pricing.ts`) tracks a per-collection floor and computes a fair value with `floor * (maxRank / rank) ^ rarityCurve`.
3. **Rules** (`src/rules.ts`) gate each listing on: absolute price cap, percent-below-floor, rarity rank, must-have / forbidden traits, minimum fair-value spread, and per-collection session budget.
4. **Risk** (`src/risk.ts`) enforces session budget, concurrent buys, min wallet balance, and an hourly loss kill-switch (auto-pauses on breach).
5. **Executor** (`src/executor/`) builds a buy instruction directly against the marketplace program — Magic Eden M2 or TensorSwap — and sends it through `JitoSender`.
6. **Jito** (`src/executor/jito.ts`) wraps the tx in a Bundle with a tip transfer. Tip size is an EMA of recent-landed tips, bumped by a contention factor derived from spread. Falls back to a direct RPC send if Jito rejects.
7. **SQLite** (`src/db.ts`) logs every considered listing (with trait JSON, floor, fair value, rationale) and every executed buy (signature, tip, success/failure).

---

## Feed provider notes

Marketplace APIs change frequently and some endpoints require a paid plan. Verify all of the following against current docs before relying on them:

- **Magic Eden**: The public v2 REST endpoints (`api-mainnet.magiceden.dev/v2`) work unauthenticated but are aggressively rate-limited. A streaming WSS is offered to partners. If you don't have access, leave `wsUrl` null and the bot will poll. Expect 2–5s latency on polling — you will lose races to WSS subscribers.
- **Tensor**: GraphQL subscription (`wss://api.tensor.so/graphql`) requires an API key in the `X-TENSOR-API-KEY` header. The field names used here (`newTransactionTV2`, `instrumentTV2`, `rarityRankTT`) reflect Tensor's schema at time of writing but **change often**. When the subscription silently stops emitting, regenerate the queries from the current schema via GraphQL introspection.
- **RPC**: You *need* a private RPC (Helius, Triton, QuickNode, etc.). Public endpoints will rate-limit you off the leaderboard within minutes.
- **Jito**: Use a block-engine URL in the region nearest your RPC. Bundles require a tip account transfer; the default in `config.example.yaml` is one of Jito's rotating tip accounts, but **pull the current list** from Jito's docs before production use.

## Marketplace program instructions

The instruction builders in `src/executor/magiceden.ts` and `src/executor/tensor.ts` sketch the PDAs, account order, and anchor discriminators. **These programs update**: regenerate typed clients from the current IDLs when going live. Concretely:

- ME M2: `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K` — pull the latest IDL from Magic Eden's published source and regenerate with `anchor idl`.
- TensorSwap: `TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN` — Tensor publishes IDLs; use `@tensor-oss/tensorswap-sdk` if you prefer a maintained client over hand-rolled layouts.

If a program upgrade changes a discriminator or account ordering and you haven't regenerated, your tx will fail preflight and you'll waste compute fees on every attempt.

## Kill switches

- **Per-session budget** (`risk.sessionBudgetSol`) — total spend cap across all collections this session.
- **Per-collection budget** (`collections[].maxSessionSpendSol`) — prevents a single collection from draining the wallet.
- **Hourly loss** (`risk.maxLossPerHourSol`) — computed from realized PnL (buy price − sale price on filled relists). Breach auto-pauses.
- **Concurrent buys** (`risk.maxConcurrentBuys`) — avoids racing yourself on correlated listings.
- **Min balance** (`risk.minWalletBalanceSol`) — refuses any buy that would dip the wallet below this.
- **Manual pause** — `bun run cli pause` writes a marker file the bot checks on every listing. Resume with `bun run cli resume`.

## Layout

```
src/
  cli.ts                 # commander: start | pause | resume | stats | history
  index.ts               # main orchestrator (feeds → rules → executor)
  config.ts              # YAML + zod schema
  types.ts               # shared Listing / BuyResult
  logger.ts              # pino
  db.ts                  # better-sqlite3: considered, executed, pnl, session_spend
  pricing.ts             # floor + rarity-adjusted fair value
  rules.ts               # declarative rule engine
  risk.ts                # kill switches
  wallet.ts              # keypair loader
  control.ts             # pause/session files
  feeds/
    magiceden.ts         # WSS + REST fallback
    tensor.ts            # GraphQL subscription
  executor/
    index.ts             # wraps buy/relist
    jito.ts              # bundle sender w/ adaptive tip
    magiceden.ts         # M2 executeSaleV2 / sellV2 ix builders
    tensor.ts            # TensorSwap buy_single_listing / list ix builders
config.example.yaml
```

## Disclaimer

Sniping is adversarial. Competing bots are better-funded, colocated, and run custom RPC + geyser. This repo gives you a working baseline — the edge comes from your RPC, your Jito tip strategy, and keeping the instruction builders in sync with program upgrades. Nothing here is financial advice. Use `dryRun: true` until you've verified every path.
