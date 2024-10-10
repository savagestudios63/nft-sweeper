import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const PAUSE_FILE = ".sweeper-paused";
const SESSION_FILE = ".sweeper-session";

export function isPausedOnDisk(): boolean {
  return existsSync(PAUSE_FILE);
}
export function setPausedOnDisk(paused: boolean) {
  if (paused) writeFileSync(PAUSE_FILE, String(Date.now()));
  else if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
}

export function currentSessionId(): string {
  if (existsSync(SESSION_FILE)) return readFileSync(SESSION_FILE, "utf8").trim();
  const id = randomUUID();
  writeFileSync(SESSION_FILE, id);
  return id;
}

export function resetSession(): string {
  const id = randomUUID();
  writeFileSync(SESSION_FILE, id);
  return id;
}
