/**
 * Applies gain to s16le PCM in place-safe fashion (returns a new buffer)
 * and reports the post-gain peak in 0..1 for the level meter.
 */
export function processPcm(
  chunk: Uint8Array,
  gain: number,
): { out: Uint8Array; peak: number } {
  const samples = chunk.length >> 1;
  const out = new Uint8Array(samples * 2);
  const src = new DataView(chunk.buffer, chunk.byteOffset, samples * 2);
  const dst = new DataView(out.buffer);
  let peak = 0;
  const unity = gain === 1;
  for (let i = 0; i < samples; i++) {
    let s = src.getInt16(i * 2, true);
    if (!unity) {
      s = Math.round(s * gain);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
    }
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    dst.setInt16(i * 2, s, true);
  }
  return { out, peak: Math.min(1, peak / 32768) };
}

/**
 * Splits an incoming TCP stream into whole audio frames, carrying any
 * partial frame over to the next chunk so samples never get misaligned.
 */
export class FrameAligner {
  private carry = new Uint8Array(0);
  constructor(private frameBytes: number) {}

  push(chunk: Uint8Array): Uint8Array {
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry, 0);
      data.set(chunk, this.carry.length);
    }
    const usable = data.length - (data.length % this.frameBytes);
    this.carry = data.slice(usable);
    return data.subarray(0, usable);
  }
}

export type LatencyMode = "low" | "stable";

/**
 * Buffer bounds per mode. Logs from real sessions: arrival gaps over 10 s windows
 * are p50 55 ms, p90 125 ms (Wi-Fi power save), so a fixed 80 ms ceiling ran dry
 * in about one window in six. "stable" starts above p90 and grows on demand.
 * "low" starts at 50 ms: the phone hands over 21 ms blocks and PipeWire pulls 10 ms at a time,
 * so at 30 ms the pw-cat stream briefly ran empty and crackled even with a clean network.
 */
export const LATENCY: Record<LatencyMode, { minMs: number; maxMs: number }> = {
  low: { minMs: 50, maxMs: 120 },
  stable: { minMs: 100, maxMs: 300 },
};

/** Post-gain peak below this (about -54 dBFS) counts as silence. */
export const QUIET_PEAK = 0.002;

export type Admit = { play: boolean; prefillMs: number };

/**
 * Adaptive jitter buffer in front of the player. It tracks how far the audio
 * written runs ahead of the wall clock ("lead").
 *
 * - Start, and restart after the player ran dry: write `targetMs` of silence
 *   first, so the next Wi-Fi hiccup up to that size is absorbed instead of heard.
 * - A dry spell after audible audio counts as an underrun and raises the target
 *   (one after silence is the phone pausing to save battery and is ignored).
 * - The target relaxes back toward the minimum after a calm spell.
 * - Excess lead is shed in quiet chunks, where dropping is inaudible, and hard
 *   capped at target + headroom so a burst cannot pile up delay.
 */
export class JitterBuffer {
  private anchor = -1;
  private writtenMs = 0;
  private lastQuiet = true;
  private lastChange: number;
  /** Audible underruns since creation. */
  underruns = 0;
  targetMs: number;

  static readonly STEP_MS = 20;
  static readonly RELAX_AFTER_MS = 30_000;
  static readonly RELAX_STEP_MS = 10;
  static readonly DRY_MS = 20;
  static readonly DRAIN_MS = 30;
  static readonly HEADROOM_MS = 100;

  constructor(
    private bytesPerMs: number,
    private bounds: { minMs: number; maxMs: number } = LATENCY.stable,
    private now: () => number = () => performance.now(),
  ) {
    this.targetMs = bounds.minMs;
    this.lastChange = now();
  }

  setBounds(b: { minMs: number; maxMs: number }) {
    this.bounds = b;
    this.targetMs = Math.min(b.maxMs, Math.max(b.minMs, this.targetMs));
    this.lastChange = this.now();
  }

  admit(bytes: number, quiet = false): Admit {
    const t = this.now();
    let prefillMs = 0;
    if (this.anchor < 0 || this.lead(t) < -JitterBuffer.DRY_MS) {
      if (this.anchor >= 0 && !this.lastQuiet) {
        this.underruns++;
        this.targetMs = Math.min(this.bounds.maxMs, this.targetMs + JitterBuffer.STEP_MS);
        this.lastChange = t;
      }
      this.anchor = t;
      this.writtenMs = prefillMs = this.targetMs;
    } else if (t - this.lastChange > JitterBuffer.RELAX_AFTER_MS && this.targetMs > this.bounds.minMs) {
      this.targetMs = Math.max(this.bounds.minMs, this.targetMs - JitterBuffer.RELAX_STEP_MS);
      this.lastChange = t;
    }
    this.lastQuiet = quiet;
    const lead = this.lead(t);
    if (lead > this.targetMs + JitterBuffer.HEADROOM_MS) return { play: false, prefillMs };
    if (quiet && lead > this.targetMs + JitterBuffer.DRAIN_MS) return { play: false, prefillMs };
    this.writtenMs += bytes / this.bytesPerMs;
    return { play: true, prefillMs };
  }

  /** Milliseconds of audio queued ahead of real time. */
  lead(t = this.now()): number {
    return this.anchor < 0 ? 0 : this.writtenMs - (t - this.anchor);
  }
}
