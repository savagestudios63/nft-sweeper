import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface BundleOutcome {
  signature: string;
  bundleId?: string;
  landed: boolean;
  error?: string;
}

export class JitoSender {
  private client?: ReturnType<typeof searcherClient>;
  private tipPubkey: PublicKey;
  private recentTips: number[] = [];

  constructor(
    private readonly cfg: Config["jito"],
    private readonly rpc: Connection,
    private readonly payer: Keypair,
    private readonly commitment: Commitment,
    private readonly log: Logger,
  ) {
    this.tipPubkey = new PublicKey(cfg.tipAccount);
    if (cfg.enabled) {
      this.client = searcherClient(cfg.blockEngineUrl);
    }
  }

  currentTipLamports(contentionBoost = 0): number {
    const floor = this.cfg.tipLamportsMin;
    const cap = this.cfg.tipLamportsMax;
    // Simple EMA of recent tips + contention boost (0..1)
    const avg =
      this.recentTips.length > 0
        ? this.recentTips.reduce((a, b) => a + b, 0) / this.recentTips.length
        : floor;
    const scaled = Math.min(cap, Math.max(floor, Math.round(avg * (1 + contentionBoost))));
    return scaled;
  }

  noteLanded(tip: number) {
    this.recentTips.push(tip);
    if (this.recentTips.length > 20) this.recentTips.shift();
  }

  async send(
    ixs: TransactionInstruction[],
    additionalSigners: Keypair[],
    contentionBoost = 0,
  ): Promise<BundleOutcome> {
    const tip = this.currentTipLamports(contentionBoost);

    if (!this.cfg.enabled || !this.client) {
      return this.sendDirect(ixs, additionalSigners);
    }

    const tipIx = SystemProgram.transfer({
      fromPubkey: this.payer.publicKey,
      toPubkey: this.tipPubkey,
      lamports: tip,
    });

    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash(
      this.commitment,
    );
    const msg = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ixs, tipIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer, ...additionalSigners]);

    const sig = Buffer.from(tx.signatures[0]!).toString("base64");

    const bundle = new Bundle([tx], 1);
    try {
      const res = await this.client.sendBundle(bundle);
      const bundleId = typeof res === "string" ? res : undefined;
      this.log.info({ bundleId, tip }, "jito bundle sent");

      const landed = await this.pollForLanding(sig, lastValidBlockHeight);
      if (landed) this.noteLanded(tip);
      return { signature: sig, bundleId, landed };
    } catch (err: any) {
      this.log.warn({ err: err?.message }, "jito send failed, falling back to direct");
      return this.sendDirect(ixs, additionalSigners);
    }
  }

  private async sendDirect(
    ixs: TransactionInstruction[],
    additionalSigners: Keypair[],
  ): Promise<BundleOutcome> {
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash(
      this.commitment,
    );
    const msg = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer, ...additionalSigners]);
    try {
      const sig = await this.rpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      const conf = await this.rpc.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        this.commitment,
      );
      return {
        signature: sig,
        landed: !conf.value.err,
        error: conf.value.err ? JSON.stringify(conf.value.err) : undefined,
      };
    } catch (err: any) {
      return { signature: "", landed: false, error: err?.message ?? String(err) };
    }
  }

  private async pollForLanding(sig: string, lastValidBlockHeight: number): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const statuses = await this.rpc.getSignatureStatuses([sig]);
      const s = statuses.value[0];
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        return !s.err;
      }
      const height = await this.rpc.getBlockHeight();
      if (height > lastValidBlockHeight) return false;
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
  }
}
