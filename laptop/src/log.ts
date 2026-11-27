import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Structured event log: one JSON object per line, written to stdout (journald)
 * and to ~/.local/state/dhvani/events.jsonl for later analysis (`dhvani report`).
 * The file rotates to events.jsonl.1 at 5 MB, so at most ~10 MB is kept.
 * File writes are queued and done off the audio path; the queue is flushed on exit.
 */
export const LOG_FILE =
  process.env.DHVANI_LOG ||
  join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local", "state"), "dhvani", "events.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;
/** A stuck disk never holds more than this much log in memory; newer lines are dropped. */
const MAX_QUEUE_BYTES = 1024 * 1024;

// `bun test` sets NODE_ENV=test; tests must never write to the user's log.
const testing = process.env.NODE_ENV === "test";
let fileOk = !testing;
let toStdout = !testing;

let queue: string[] = [];
let queuedBytes = 0;
let dropped = 0;
let writing = false;
/** Bytes in LOG_FILE, read once and then counted, so rotation needs no stat per line. */
let fileBytes = -1;

/** Tests turn logging off so they do not touch the user's log. */
export function configureLog(opts: { file?: boolean; stdout?: boolean }) {
  if (opts.file !== undefined) fileOk = opts.file;
  if (opts.stdout !== undefined) toStdout = opts.stdout;
}

/** The event's own `t` and `ev` always win over same-named fields. */
export function logLine(ev: string, fields: Record<string, unknown>, t = new Date().toISOString()): string {
  return JSON.stringify(Object.assign({ t, ev }, fields, { t, ev }));
}

export function log(ev: string, fields: Record<string, unknown> = {}): void {
  const line = logLine(ev, fields);
  if (toStdout) console.log(line);
  if (!fileOk) return;
  if (queuedBytes + line.length > MAX_QUEUE_BYTES) {
    dropped++;
    return;
  }
  queue.push(line + "\n");
  queuedBytes += line.length + 1;
  if (!writing) {
    writing = true;
    setTimeout(() => void drain(), 0);
  }
}

function take(): string {
  if (dropped) {
    queue.push(logLine("log_dropped", { lines: dropped }) + "\n");
    dropped = 0;
  }
  const text = queue.join("");
  queue = [];
  queuedBytes = 0;
  return text;
}

async function drain() {
  try {
    while (queue.length && fileOk) {
      const text = take();
      if (fileBytes < 0) {
        await mkdir(dirname(LOG_FILE), { recursive: true });
        fileBytes = await stat(LOG_FILE).then((s) => s.size, () => 0);
      }
      if (fileBytes > MAX_BYTES) {
        await rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {});
        fileBytes = 0;
      }
      await appendFile(LOG_FILE, text);
      fileBytes += Buffer.byteLength(text);
    }
  } catch {
    fileOk = false; // read-only home or similar: keep going with journald only
    queue = [];
    queuedBytes = 0;
  } finally {
    writing = false;
  }
}

/** Writes whatever is still queued, synchronously. Runs on exit. */
export function flushLog(): void {
  if (!fileOk || !queue.length) return;
  try {
    const text = take();
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    appendFileSync(LOG_FILE, text);
  } catch {
    fileOk = false;
  }
}

process.on("exit", flushLog);
