import { spawn, execFile } from "node:child_process";
import { JitterBuffer, LATENCY, type LatencyMode } from "./audio";

export type PlayerOptions = { rate: number; channels: number; sink: string; latency?: LatencyMode };

/** ok = queued; late = dropped, too far ahead of real time; stalled = pw-cat not reading. */
export type WriteResult = "ok" | "late" | "stalled" | "closed";

export interface Player {
  /** `quiet`: the chunk is near-silent, so it may be dropped to shed delay. */
  write(pcm: Uint8Array, quiet?: boolean): WriteResult;
  /** Current jitter-buffer target, ms. */
  readonly targetMs: number;
  setLatency(mode: LatencyMode): void;
  close(): void;
  readonly closed: boolean;
  /** Audio queued ahead of real time, ms. */
  readonly leadMs: number;
  /** Times playback ran dry since this player started. */
  readonly underruns: number;
}

export type PlayerFactory = (
  opts: PlayerOptions,
  onExit: (reason: string) => void,
) => Player;

/** Hard cap on audio stuck in Node's pipe buffer (pw-cat stalled). */
export const MAX_BACKLOG_MS = 150;

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
  const frameBytes = opts.channels * 2;
  const lead = new JitterBuffer(bytesPerMs, LATENCY[opts.latency ?? "stable"]);
  // The backlog cap must leave room for the buffer's own prefill.
  const maxBacklog = Math.round(bytesPerMs * (MAX_BACKLOG_MS + LATENCY.stable.maxMs));
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
    get leadMs() {
      return lead.lead();
    },
    get underruns() {
      return lead.underruns;
    },
    get targetMs() {
      return lead.targetMs;
    },
    setLatency(mode) {
      lead.setBounds(LATENCY[mode]);
    },
    write(pcm, quiet = false) {
      if (closed) return "closed";
      if (child.stdin.writableLength > maxBacklog) return "stalled";
      const a = lead.admit(pcm.length, quiet);
      if (a.prefillMs > 0) {
        const n = Math.round((a.prefillMs * bytesPerMs) / frameBytes) * frameBytes;
        child.stdin.write(new Uint8Array(n));
      }
      if (!a.play) return "late";
      child.stdin.write(pcm);
      return "ok";
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
