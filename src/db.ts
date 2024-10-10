import Database from "better-sqlite3";
import type { Listing, BuyResult, Trait } from "./types.js";

export class SweeperDB {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS considered (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        collection TEXT NOT NULL,
        mint TEXT NOT NULL,
        price_sol REAL NOT NULL,
        floor_sol REAL,
        fair_value_sol REAL,
        rank INTEGER,
        traits_json TEXT,
        matched INTEGER NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS considered_collection_ts ON considered(collection, ts);
      CREATE INDEX IF NOT EXISTS considered_matched_ts ON considered(matched, ts);

      CREATE TABLE IF NOT EXISTS executed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        collection TEXT NOT NULL,
        mint TEXT NOT NULL,
        price_sol REAL NOT NULL,
        tip_lamports INTEGER,
        signature TEXT,
        success INTEGER NOT NULL,
        error TEXT,
        rationale TEXT
      );
      CREATE INDEX IF NOT EXISTS executed_ts ON executed(ts);

      CREATE TABLE IF NOT EXISTS pnl (
        mint TEXT PRIMARY KEY,
        bought_ts INTEGER,
        buy_price_sol REAL,
        relisted_at_sol REAL,
        sold_price_sol REAL,
        sold_ts INTEGER
      );

      CREATE TABLE IF NOT EXISTS session_spend (
        collection TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        spent_sol REAL NOT NULL DEFAULT 0
      );
    `);
  }

  logConsidered(args: {
    listing: Listing;
    floorSol: number | null;
    fairValueSol: number | null;
    matched: boolean;
    reason: string;
  }) {
    const stmt = this.db.prepare(
      `INSERT INTO considered (ts, source, collection, mint, price_sol, floor_sol, fair_value_sol, rank, traits_json, matched, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    stmt.run(
      Date.now(),
      args.listing.source,
      args.listing.collectionSlug,
      args.listing.mint,
      args.listing.priceSol,
      args.floorSol,
      args.fairValueSol,
      args.listing.rank ?? null,
      args.listing.traits ? JSON.stringify(args.listing.traits) : null,
      args.matched ? 1 : 0,
      args.reason,
    );
  }

  logExecuted(r: BuyResult, tipLamports: number, rationale: string) {
    const stmt = this.db.prepare(
      `INSERT INTO executed (ts, source, collection, mint, price_sol, tip_lamports, signature, success, error, rationale)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    stmt.run(
      r.landedAt,
      r.listing.source,
      r.listing.collectionSlug,
      r.listing.mint,
      r.costSol,
      tipLamports,
      r.signature ?? null,
      r.success ? 1 : 0,
      r.error ?? null,
      rationale,
    );
    if (r.success) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO pnl (mint, bought_ts, buy_price_sol) VALUES (?,?,?)`,
        )
        .run(r.listing.mint, r.landedAt, r.costSol);
    }
  }

  recordRelist(mint: string, relistedAtSol: number) {
    this.db
      .prepare(`UPDATE pnl SET relisted_at_sol = ? WHERE mint = ?`)
      .run(relistedAtSol, mint);
  }

  recordSale(mint: string, soldPriceSol: number) {
    this.db
      .prepare(`UPDATE pnl SET sold_price_sol = ?, sold_ts = ? WHERE mint = ?`)
      .run(soldPriceSol, Date.now(), mint);
  }

  sessionSpend(collection: string, sessionId: string): number {
    const row = this.db
      .prepare(`SELECT spent_sol, session_id FROM session_spend WHERE collection = ?`)
      .get(collection) as { spent_sol: number; session_id: string } | undefined;
    if (!row || row.session_id !== sessionId) return 0;
    return row.spent_sol;
  }

  addSessionSpend(collection: string, sessionId: string, sol: number) {
    const existing = this.db
      .prepare(`SELECT session_id, spent_sol FROM session_spend WHERE collection = ?`)
      .get(collection) as { session_id: string; spent_sol: number } | undefined;
    if (!existing || existing.session_id !== sessionId) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO session_spend (collection, session_id, spent_sol) VALUES (?,?,?)`,
        )
        .run(collection, sessionId, sol);
    } else {
      this.db
        .prepare(`UPDATE session_spend SET spent_sol = spent_sol + ? WHERE collection = ?`)
        .run(sol, collection);
    }
  }

  recentLossSol(sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(buy_price_sol - COALESCE(sold_price_sol, buy_price_sol)), 0) AS loss
         FROM pnl WHERE bought_ts >= ? AND sold_price_sol IS NOT NULL AND sold_price_sol < buy_price_sol`,
      )
      .get(sinceMs) as { loss: number };
    return row.loss ?? 0;
  }

  stats() {
    const totalConsidered = (this.db.prepare(`SELECT COUNT(*) c FROM considered`).get() as { c: number }).c;
    const totalMatched = (this.db.prepare(`SELECT COUNT(*) c FROM considered WHERE matched=1`).get() as { c: number }).c;
    const totalExecuted = (this.db.prepare(`SELECT COUNT(*) c FROM executed WHERE success=1`).get() as { c: number }).c;
    const totalSpent = (this.db.prepare(`SELECT COALESCE(SUM(price_sol),0) s FROM executed WHERE success=1`).get() as { s: number }).s;
    return { totalConsidered, totalMatched, totalExecuted, totalSpent };
  }

  history(limit = 25) {
    return this.db
      .prepare(
        `SELECT ts, collection, mint, price_sol, success, signature, error, rationale
         FROM executed ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit);
  }

  close() {
    this.db.close();
  }
}

export function serializeTraits(t?: Trait[]): string | null {
  return t ? JSON.stringify(t) : null;
}
