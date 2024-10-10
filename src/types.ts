import type { PublicKey } from "@solana/web3.js";

export type Marketplace = "magiceden" | "tensor";

export interface Trait {
  name: string;
  value: string;
}

export interface Listing {
  source: Marketplace;
  mint: string;                  // NFT mint address (base58)
  tokenName?: string;
  collectionSlug: string;
  priceSol: number;
  seller: string;                // seller wallet (base58)
  listedAt: number;              // ms epoch
  rank?: number;                 // 1 = rarest
  traits?: Trait[];
  // Marketplace-specific payload we later pass to the executor.
  raw: unknown;
}

export interface CollectionState {
  slug: string;
  floorSol: number;
  floorUpdatedAt: number;
  maxRank?: number;
}

export interface BuyDecision {
  listing: Listing;
  reason: string;
  fairValueSol: number;
  spreadPct: number;
  tipLamports: number;
}

export interface BuyResult {
  listing: Listing;
  signature?: string;
  success: boolean;
  error?: string;
  costSol: number;
  landedAt: number;
}

export type Pubkey = PublicKey;
