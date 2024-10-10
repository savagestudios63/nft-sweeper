import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Listing, Trait } from "../types.js";

export type ListingHandler = (l: Listing) => void;

// Tensor's real schema changes. These queries are representative —
// update to match the current Tensor docs.
const LISTING_SUB = /* GraphQL */ `
  subscription NewTransactionTV2($slug: String!) {
    newTransactionTV2(slug: $slug) {
      tx {
        txType
        grossAmount
        grossAmountUnit
        mintOnchainId
        sellerId
        blockTime
      }
      mint {
        onchainId
        name
        rarityRankTT
        attributes { trait_type value }
      }
    }
  }
`;

const FLOOR_QUERY = /* GraphQL */ `
  query Floor($slug: String!) {
    instrumentTV2(slug: $slug) {
      statsV2 { buyNowPrice numListed }
    }
  }
`;

export class TensorFeed {
  private client?: Client;
  private seen = new Set<string>();
  private stopping = false;
  private floorPoller?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config["feeds"]["tensor"],
    private readonly slugs: string[],
    private readonly log: Logger,
    private readonly onListing: ListingHandler,
    private readonly onFloor: (slug: string, floorSol: number) => void,
  ) {}

  async start() {
    if (!this.cfg.enabled || this.slugs.length === 0) return;
    this.log.info({ slugs: this.slugs }, "Tensor feed starting");

    this.client = createClient({
      url: this.cfg.wsUrl,
      webSocketImpl: WebSocket as any,
      connectionParams: { "X-TENSOR-API-KEY": this.cfg.apiKey },
      retryAttempts: Infinity,
    });

    for (const slug of this.slugs) this.subscribe(slug);

    // Poll floor every 20s — Tensor's subscription stream doesn't always include floor ticks.
    this.floorPoller = setInterval(() => void this.refreshFloors(), 20_000);
    void this.refreshFloors();
  }

  stop() {
    this.stopping = true;
    if (this.floorPoller) clearInterval(this.floorPoller);
    this.client?.dispose();
  }

  private subscribe(slug: string) {
    if (!this.client) return;
    this.client.subscribe(
      { query: LISTING_SUB, variables: { slug } },
      {
        next: (msg) => this.handleTx(slug, msg.data as any),
        error: (err) => this.log.warn({ err, slug }, "tensor sub error"),
        complete: () => {
          if (this.stopping) return;
          this.log.info({ slug }, "tensor sub closed, retrying");
          setTimeout(() => this.subscribe(slug), 2000);
        },
      },
    );
  }

  private handleTx(slug: string, data: any) {
    const tx = data?.newTransactionTV2?.tx;
    const mint = data?.newTransactionTV2?.mint;
    if (!tx || tx.txType !== "LIST") return; // only fresh listings
    const priceLamports = Number(tx.grossAmount);
    if (!Number.isFinite(priceLamports)) return;

    const traits: Trait[] | undefined = Array.isArray(mint?.attributes)
      ? mint.attributes
          .filter((a: any) => a?.trait_type && a?.value != null)
          .map((a: any) => ({ name: String(a.trait_type), value: String(a.value) }))
      : undefined;

    const listing: Listing = {
      source: "tensor",
      mint: mint?.onchainId ?? tx.mintOnchainId,
      tokenName: mint?.name,
      collectionSlug: slug,
      priceSol: priceLamports / 1e9,
      seller: tx.sellerId,
      listedAt: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      rank: typeof mint?.rarityRankTT === "number" ? mint.rarityRankTT : undefined,
      traits,
      raw: data.newTransactionTV2,
    };

    const key = `${listing.mint}:${listing.priceSol}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 10_000) this.seen.clear();
    this.onListing(listing);
  }

  private async refreshFloors() {
    for (const slug of this.slugs) {
      try {
        const res = await fetch(this.cfg.apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-TENSOR-API-KEY": this.cfg.apiKey,
          },
          body: JSON.stringify({ query: FLOOR_QUERY, variables: { slug } }),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as any;
        const buyNow = body?.data?.instrumentTV2?.statsV2?.buyNowPrice;
        if (buyNow) this.onFloor(slug, Number(buyNow) / 1e9);
      } catch (err) {
        this.log.debug({ err, slug }, "tensor floor refresh failed");
      }
    }
  }
}
