import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Structured event log: one JSON object per line, written to stdout (journald)
 * and to ~/.local/state/dhvani/events.jsonl for later analysis (`dhvani report`).
 * The file rotates to events.jsonl.1 at 5 MB, so at most ~10 MB is kept.
 */
export const LOG_FILE =
  process.env.DHVANI_LOG ||
  join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local", "state"), "dhvani", "events.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;

// `bun test` sets NODE_ENV=test; tests must never write to the user's log.
const testing = process.env.NODE_ENV === "test";
let fileOk = !testing;
let toStdout = !testing;

/** Tests turn logging off so they do not touch the user's log. */
export function configureLog(opts: { file?: boolean; stdout?: boolean }) {
  if (opts.file !== undefined) fileOk = opts.file;
  if (opts.stdout !== undefined) toStdout = opts.stdout;
}

export function log(ev: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ev, ...fields });
  if (toStdout) console.log(line);
  if (!fileOk) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    fileOk = false; // read-only home or similar: keep going with journald only
  }
}
