import { spawn, execFile } from "node:child_process";
import { LeadLimiter } from "./audio";

export type PlayerOptions = { rate: number; channels: number; sink: string };

export interface Player {
  /** Queues PCM. Returns false if dropped because playback is behind. */
  write(pcm: Uint8Array): boolean;
  close(): void;
  readonly closed: boolean;
}

export type PlayerFactory = (
  opts: PlayerOptions,
  onExit: (reason: string) => void,
) => Player;

/** Hard cap on audio stuck in Node's pipe buffer (pw-cat stalled). */
export const MAX_BACKLOG_MS = 150;
/** Target ceiling for audio queued ahead of real time. */
export const MAX_LEAD_MS = 80;

export const pwCatPlayer: PlayerFactory = (opts, onExit) => {
  const args = [
    "--playback",
    "--raw",
    "--format", "s16",
    "--rate", String(opts.rate),
    "--channels", String(opts.channels),
    "--latency", "30ms",
    "-P", JSON.stringify({
      "media.name": "Phone audio",
      "application.name": "Dhvani",
      "node.name": "dhvani",
      "node.description": "Phone audio (Dhvani)",
    }),
  ];
  if (opts.sink) args.push("--target", opts.sink);
  args.push("-");

  const child = spawn("pw-cat", args, { stdio: ["pipe", "ignore", "pipe"] });
  const bytesPerMs = (opts.rate * opts.channels * 2) / 1000;
  const maxBacklog = Math.round(bytesPerMs * MAX_BACKLOG_MS);
  const lead = new LeadLimiter(bytesPerMs, MAX_LEAD_MS);
  let closed = false;
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-500);
  });
  child.stdin.on("error", () => {});
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    onExit(reason);
  };
  child.on("error", (e) => finish(`pw-cat failed to start: ${e.message}`));
  child.on("exit", (code, signal) =>
    finish(signal ? `pw-cat stopped (${signal})` : `pw-cat exited (${code}) ${stderr.trim()}`.trim()),
  );

  return {
    get closed() {
      return closed;
    },
    write(pcm) {
      if (closed) return false;
      if (child.stdin.writableLength > maxBacklog) return false;
      if (!lead.admit(pcm.length)) return false;
      child.stdin.write(pcm);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 200).unref();
    },
  };
};

export type Sink = { name: string; description: string };

export function listSinks(): Promise<{ sinks: Sink[]; defaultSink: string }> {
  return new Promise((resolve) => {
    execFile("pactl", ["-f", "json", "list", "sinks"], { timeout: 3000 }, (err, out) => {
      let sinks: Sink[] = [];
      if (!err) {
        try {
          sinks = (JSON.parse(out) as { name: string; description: string }[]).map((s) => ({
            name: s.name,
            description: s.description || s.name,
          }));
        } catch {}
      }
      execFile("pactl", ["get-default-sink"], { timeout: 3000 }, (e2, def) => {
        resolve({ sinks, defaultSink: e2 ? "" : def.trim() });
      });
    });
  });
}
