import type { Config } from "./config.js";
import type { SweeperDB } from "./db.js";

export type RiskVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export class RiskManager {
  private paused = false;
  private activeBuys = 0;
  private sessionSpentSol = 0;

  constructor(
    private readonly cfg: Config,
    private readonly db: SweeperDB,
    private readonly sessionId: string,
    private readonly walletBalanceProvider: () => Promise<number>,
  ) {}

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  isPaused() { return this.paused; }

  beginBuy() { this.activeBuys++; }
  endBuy() { this.activeBuys = Math.max(0, this.activeBuys - 1); }

  noteSpend(sol: number) { this.sessionSpentSol += sol; }
  totalSpent() { return this.sessionSpentSol; }

  async canBuy(priceSol: number): Promise<RiskVerdict> {
    if (this.paused) return { ok: false, reason: "paused" };

    if (this.activeBuys >= this.cfg.risk.maxConcurrentBuys) {
      return { ok: false, reason: `max concurrent buys (${this.cfg.risk.maxConcurrentBuys})` };
    }

    if (this.sessionSpentSol + priceSol > this.cfg.risk.sessionBudgetSol) {
      return {
        ok: false,
        reason: `session budget exceeded (${(this.sessionSpentSol + priceSol).toFixed(3)} > ${this.cfg.risk.sessionBudgetSol})`,
      };
    }

    const lossHour = this.db.recentLossSol(Date.now() - 60 * 60 * 1000);
    if (lossHour >= this.cfg.risk.maxLossPerHourSol) {
      this.paused = true;
      return { ok: false, reason: `hourly loss ${lossHour.toFixed(3)} exceeded limit — auto-paused` };
    }

    const bal = await this.walletBalanceProvider();
    if (bal - priceSol < this.cfg.risk.minWalletBalanceSol) {
      return {
        ok: false,
        reason: `post-buy wallet would dip below ${this.cfg.risk.minWalletBalanceSol} SOL (bal=${bal.toFixed(3)})`,
      };
    }

    return { ok: true };
  }

  sessionSpendFor(collection: string): number {
    return this.db.sessionSpend(collection, this.sessionId);
  }

  recordSpend(collection: string, sol: number) {
    this.sessionSpentSol += sol;
    this.db.addSessionSpend(collection, this.sessionId, sol);
  }
}
