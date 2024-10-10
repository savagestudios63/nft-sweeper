import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BuyResult, Listing } from "../types.js";
import { JitoSender } from "./jito.js";
import { buildBuyInstructions as meBuy, buildRelistInstructions as meRelist } from "./magiceden.js";
import {
  buildBuyInstructions as tnBuy,
  buildRelistInstructions as tnRelist,
} from "./tensor.js";

export class Executor {
  constructor(
    private readonly cfg: Config,
    private readonly rpc: Connection,
    private readonly payer: Keypair,
    private readonly jito: JitoSender,
    private readonly log: Logger,
  ) {}

  async buy(listing: Listing, contentionBoost = 0): Promise<BuyResult> {
    const mint = new PublicKey(listing.mint);
    const seller = new PublicKey(listing.seller);
    const priceLamports = BigInt(Math.round(listing.priceSol * 1e9));

    let ixs: TransactionInstruction[];
    if (listing.source === "magiceden") {
      ixs = meBuy({
        buyer: this.payer.publicKey,
        seller,
        tokenMint: mint,
        priceLamports,
      });
    } else {
      ixs = tnBuy({
        buyer: this.payer.publicKey,
        seller,
        tokenMint: mint,
        priceLamports,
        maxPriceLamports: priceLamports, // no slippage above quoted price
      });
    }

    if (this.cfg.risk.dryRun) {
      this.log.warn({ mint: listing.mint }, "dryRun=true, skipping on-chain send");
      return {
        listing,
        success: true,
        costSol: listing.priceSol,
        landedAt: Date.now(),
      };
    }

    const out = await this.jito.send(ixs, [], contentionBoost);
    return {
      listing,
      signature: out.signature,
      success: out.landed,
      error: out.error,
      costSol: listing.priceSol,
      landedAt: Date.now(),
    };
  }

  async relist(listing: Listing, newPriceSol: number): Promise<BuyResult> {
    const mint = new PublicKey(listing.mint);
    const newLamports = BigInt(Math.round(newPriceSol * 1e9));
    const expiry = this.cfg.postBuy.relistExpirySec;
    const market = this.cfg.postBuy.relistMarketplace;

    const ixs =
      market === "tensor"
        ? tnRelist({
            seller: this.payer.publicKey,
            tokenMint: mint,
            newPriceLamports: newLamports,
            expirySec: expiry,
          })
        : meRelist({
            seller: this.payer.publicKey,
            tokenMint: mint,
            newPriceLamports: newLamports,
            expirySec: expiry,
          });

    if (this.cfg.risk.dryRun) {
      return { listing, success: true, costSol: 0, landedAt: Date.now() };
    }

    const out = await this.jito.send(ixs, [], 0);
    return {
      listing,
      signature: out.signature,
      success: out.landed,
      error: out.error,
      costSol: 0,
      landedAt: Date.now(),
    };
  }
}
