import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected array keypair`);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
