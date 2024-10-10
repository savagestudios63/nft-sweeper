import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

const TraitSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const CollectionSchema = z.object({
  name: z.string(),
  magicedenSlug: z.string().optional(),
  tensorSlug: z.string().optional(),
  maxBuyPriceSol: z.number().positive(),
  maxPctBelowFloor: z.number().min(0).max(100).optional(),
  maxSessionSpendSol: z.number().positive(),
  rarity: z
    .object({
      maxRank: z.number().int().positive().optional(),
      unknownRankDefault: z.number().int().nullable().optional(),
    })
    .default({}),
  traits: z
    .object({
      mustHave: z.array(TraitSchema).default([]),
      forbidden: z.array(TraitSchema).default([]),
    })
    .default({ mustHave: [], forbidden: [] }),
});

export const ConfigSchema = z.object({
  rpc: z.object({
    url: z.string().url(),
    ws: z.string().url().optional(),
    commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  }),
  wallet: z.object({
    keypairPath: z.string(),
  }),
  jito: z.object({
    enabled: z.boolean().default(true),
    blockEngineUrl: z.string().url(),
    tipLamportsMin: z.number().int().nonnegative(),
    tipLamportsMax: z.number().int().nonnegative(),
    tipAccount: z.string(),
  }),
  feeds: z.object({
    magiceden: z.object({
      enabled: z.boolean().default(true),
      wsUrl: z.string().optional(),
      pollIntervalMs: z.number().int().positive().default(2500),
      apiKey: z.string().nullable().optional(),
    }),
    tensor: z.object({
      enabled: z.boolean().default(true),
      apiUrl: z.string().url(),
      wsUrl: z.string(),
      apiKey: z.string(),
    }),
  }),
  risk: z.object({
    sessionBudgetSol: z.number().positive(),
    maxLossPerHourSol: z.number().positive(),
    maxConcurrentBuys: z.number().int().positive().default(1),
    minWalletBalanceSol: z.number().nonnegative().default(0.1),
    dryRun: z.boolean().default(false),
  }),
  pricing: z.object({
    rarityCurve: z.number().default(0.35),
    floorStaleMs: z.number().int().positive().default(30_000),
    minSpreadPct: z.number().default(5),
  }),
  postBuy: z.object({
    autoRelist: z.boolean().default(false),
    relistMarketplace: z.enum(["magiceden", "tensor"]).default("tensor"),
    relistMarkupPct: z.number().default(15),
    relistExpirySec: z.number().int().positive().default(21_600),
  }),
  collections: z.array(CollectionSchema).min(1),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    dbPath: z.string().default("./sweeper.db"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type CollectionRule = z.infer<typeof CollectionSchema>;

export function loadConfig(path = "./config.yaml"): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw);
  return ConfigSchema.parse(parsed);
}
