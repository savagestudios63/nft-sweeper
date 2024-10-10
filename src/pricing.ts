import type { CollectionState, Listing } from "./types.js";

export class PricingEngine {
  private floors = new Map<string, CollectionState>();

  constructor(
    private readonly rarityCurve: number,
    private readonly floorStaleMs: number,
  ) {}

  updateFloor(slug: string, floorSol: number, maxRank?: number) {
    this.floors.set(slug, {
      slug,
      floorSol,
      floorUpdatedAt: Date.now(),
      maxRank,
    });
  }

  getFloor(slug: string): number | null {
    const s = this.floors.get(slug);
    if (!s) return null;
    if (Date.now() - s.floorUpdatedAt > this.floorStaleMs) return null;
    return s.floorSol;
  }

  // Rarity-adjusted fair value: rarer pieces are worth more than floor.
  // fair = floor * (maxRank / rank) ^ rarityCurve, bounded for safety.
  fairValue(listing: Listing): number | null {
    const floor = this.getFloor(listing.collectionSlug);
    if (floor == null) return null;
    if (listing.rank == null) return floor;

    const state = this.floors.get(listing.collectionSlug);
    const maxRank = state?.maxRank ?? 10_000;
    const r = Math.max(1, listing.rank);
    const ratio = maxRank / r;
    const multiplier = Math.min(6, Math.pow(ratio, this.rarityCurve));
    return floor * multiplier;
  }

  spreadPct(listing: Listing): number | null {
    const fair = this.fairValue(listing);
    if (fair == null) return null;
    return ((fair - listing.priceSol) / listing.priceSol) * 100;
  }
}
