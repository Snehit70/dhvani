import { spawn, execFile } from "node:child_process";
import { JitterBuffer, LATENCY, declick, lastFrame, latencyBounds, type LatencyMode } from "./audio";
import { Accelerator } from "./stretch";

export type PlayerOptions = { rate: number; channels: number; sink: string; latency?: LatencyMode; screenOff?: boolean };

/**
 * ok = queued (maybe shortened); quiet = near-silent excess dropped unheard;
 * late = dropped, too far ahead of real time; stalled = pw-cat not reading.
 */
export type WriteResult = "ok" | "quiet" | "late" | "stalled" | "closed";

export interface Player {
  /** `quiet`: the chunk is near-silent, so it may be dropped to shed delay. */
  write(pcm: Uint8Array, quiet?: boolean): WriteResult;
  /** Current jitter-buffer target, ms. */
  readonly targetMs: number;
  /** `screenOff`: the phone screen is off, so Wi-Fi may doze; hold more audio. */
  setLatency(mode: LatencyMode, screenOff?: boolean): void;
  /** Audio was skipped before the next write: smooth the join. */
  gap?(): void;
  close(): void;
  readonly closed: boolean;
  /** Audio queued ahead of real time, ms. */
  readonly leadMs: number;
  /** Times playback ran dry since this player started. */
  readonly underruns: number;
  /** Audio removed by playing faster to shed delay, ms, since this player started. */
  readonly compressedMs: number;
}

export type PlayerFactory = (
  opts: PlayerOptions,
  onExit: (reason: string) => void,
) => Player;

/**
 * PipeWire buffer pw-cat asks for. It sets the graph period while Dhvani plays, so it adds
 * that much delay after the jitter buffer: 30 ms was a 1440-frame period.
 */
export const PW_LATENCY_MS: Record<LatencyMode, number> = { low: 10, stable: 20 };

/** Hard cap on audio stuck in Node's pipe buffer (pw-cat stalled). */
export const MAX_BACKLOG_MS = 150;

export const pwCatPlayer: PlayerFactory = (opts, onExit) => {
  const args = [
    "--playback",
    "--raw",
    "--format", "s16",
    "--rate", String(opts.rate),
    "--channels", String(opts.channels),
    "--latency", `${PW_LATENCY_MS[opts.latency ?? "stable"]}ms`,
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
  const lead = new JitterBuffer(bytesPerMs, latencyBounds(opts.latency ?? "stable", opts.screenOff));
  const accel = new Accelerator(opts.channels, opts.rate);
  // The backlog cap must leave room for the buffer's own prefill.
  const maxBacklog = Math.round(bytesPerMs * (MAX_BACKLOG_MS + LATENCY.stable.maxMs));
  let closed = false;
  let stderr = "";
  // Last samples handed to pw-cat, and whether the next write follows a skip or inserted silence.
  let last: number[] = new Array(opts.channels).fill(0);
  let splice = false;
  const put = (b: Uint8Array) => {
    if (!b.length) return;
    child.stdin.write(b);
    last = lastFrame(b, opts.channels) ?? last;
  };
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
    get compressedMs() {
      return accel.removedMs;
    },
    setLatency(mode, screenOff = false) {
      lead.setBounds(latencyBounds(mode, screenOff));
    },
    gap() {
      splice = true;
    },
    write(pcm, quiet = false) {
      if (closed) return "closed";
      if (child.stdin.writableLength > maxBacklog) {
        splice = true;
        return "stalled";
      }
      const a = lead.admit(pcm.length, quiet);
      if (a.prefillMs > 0) {
        const n = Math.round((a.prefillMs * bytesPerMs) / frameBytes) * frameBytes;
        put(new Uint8Array(n));
        splice = true;
      }
      if (a.mode === "late" || a.mode === "quiet") {
        splice = true;
        return a.mode;
      }
      const smooth = () => {
        if (!splice) return;
        declick(pcm, last, opts.channels);
        splice = false;
      };
      if (a.mode === "compress") {
        smooth();
        const out = accel.push(pcm);
        if (out.length) {
          put(out);
          lead.wrote(out.length);
        }
        return "ok";
      }
      // Back on target: anything held for compression plays first, unchanged.
      const held = accel.flush();
      if (held.length) {
        put(held);
        lead.wrote(held.length);
      }
      smooth();
      put(pcm);
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

export type OutputDelay = { ms: number; device: string; bluetooth: boolean };

/**
 * Delay after Dhvani hands audio to PipeWire: its own period plus what the output device
 * reports (Bluetooth codecs add 100-250 ms). Null when Dhvani is not playing or pw-dump fails.
 */
export function outputDelay(latency: LatencyMode): Promise<OutputDelay | null> {
  return new Promise((resolve) => {
    execFile("pw-dump", [], { timeout: 3000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve(null);
      try {
        resolve(parseOutputDelay(JSON.parse(out), PW_LATENCY_MS[latency]));
      } catch {
        resolve(null);
      }
    });
  });
}

type PwObject = { id: number; type: string; info?: { props?: Record<string, unknown>; params?: Record<string, unknown[]>; [k: string]: unknown } };

export function parseOutputDelay(dump: PwObject[], periodMs: number): OutputDelay | null {
  const nodes = dump.filter((o) => o.type === "PipeWire:Interface:Node");
  const me = nodes.find((n) => n.info?.props?.["node.name"] === "dhvani");
  if (!me) return null;
  const link = dump.find((o) => o.type === "PipeWire:Interface:Link" && o.info?.["output-node-id"] === me.id);
  const sink = link && nodes.find((n) => n.id === link.info?.["input-node-id"]);
  if (!sink) return null;
  const lat = (sink.info?.params?.Latency ?? []) as { direction?: string; minNs?: number }[];
  const ns = lat.find((l) => l.direction === "Input")?.minNs ?? 0;
  const name = String(sink.info?.props?.["node.name"] ?? "");
  return {
    ms: Math.round(periodMs + ns / 1e6),
    device: String(sink.info?.props?.["node.description"] ?? name),
    bluetooth: name.startsWith("bluez_"),
  };
}
