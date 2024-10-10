#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { SweeperDB } from "./db.js";
import { run } from "./index.js";
import { isPausedOnDisk, setPausedOnDisk, resetSession } from "./control.js";

const program = new Command();
program.name("sweeper").description("Solana NFT floor sniper");

program
  .command("start")
  .description("run the sniper")
  .option("-c, --config <path>", "config file", "./config.yaml")
  .option("--fresh", "start a new session (reset per-collection budgets)")
  .action(async (opts) => {
    if (opts.fresh) resetSession();
    if (isPausedOnDisk()) setPausedOnDisk(false);
    await run(opts.config);
  });

program
  .command("pause")
  .description("block further buys (writes a pause marker; bot picks it up on next listing)")
  .action(() => {
    setPausedOnDisk(true);
    console.log("paused");
  });

program
  .command("resume")
  .description("clear the pause marker")
  .action(() => {
    setPausedOnDisk(false);
    console.log("resumed");
  });

program
  .command("stats")
  .description("show aggregate session stats")
  .option("-c, --config <path>", "config file", "./config.yaml")
  .action((opts) => {
    const cfg = loadConfig(opts.config);
    const db = new SweeperDB(cfg.logging.dbPath);
    const s = db.stats();
    console.log(
      [
        `considered:  ${s.totalConsidered}`,
        `matched:     ${s.totalMatched}`,
        `executed OK: ${s.totalExecuted}`,
        `total spent: ${s.totalSpent.toFixed(4)} SOL`,
        `paused:      ${isPausedOnDisk()}`,
      ].join("\n"),
    );
    db.close();
  });

program
  .command("history")
  .description("show recent executed snipes")
  .option("-c, --config <path>", "config file", "./config.yaml")
  .option("-n, --limit <n>", "rows", "25")
  .action((opts) => {
    const cfg = loadConfig(opts.config);
    const db = new SweeperDB(cfg.logging.dbPath);
    const rows = db.history(Number(opts.limit));
    for (const r of rows as any[]) {
      const when = new Date(r.ts).toISOString();
      const status = r.success ? "OK " : "FAIL";
      console.log(
        `${when}  ${status}  ${r.collection.padEnd(20)}  ${r.price_sol.toFixed(3)} SOL  ${r.mint}  ${r.signature ?? ""}  ${r.error ?? ""}`,
      );
    }
    db.close();
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
