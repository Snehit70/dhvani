/** Loudest sample the limiter lets through, about -0.4 dBFS. */
const LIMIT_CEIL = 31_130;
/** How long the limiter takes to give gain back after a peak. */
const LIMIT_RELEASE_MS = 80;

/**
 * Applies gain to s16le PCM and reports the post-gain peak in 0..1 for the level meter.
 * Above unity gain, loud peaks would clip, and hard clipping is heard as crackle. So a
 * limiter turns the gain down at once on any frame that would pass LIMIT_CEIL and lets
 * it recover smoothly. One instance per stream keeps that state across chunks.
 */
export class Limiter {
  /** Gain reduction currently applied, 1 when idle. */
  private env = 1;
  private readonly release: number;
  constructor(private readonly channels: number, rate: number) {
    this.release = 1 - Math.exp(-1 / ((LIMIT_RELEASE_MS / 1000) * rate));
  }
  process(chunk: Uint8Array, gain: number): { out: Uint8Array; peak: number } {
    const ch = Math.max(1, this.channels);
    const frames = Math.floor(chunk.length / (2 * ch));
    const out = new Uint8Array(frames * ch * 2);
    const src = new DataView(chunk.buffer, chunk.byteOffset, frames * ch * 2);
    const dst = new DataView(out.buffer);
    let peak = 0;
    const unity = gain === 1 && this.env === 1;
    for (let f = 0; f < frames; f++) {
      const base = f * ch * 2;
      if (unity) {
        for (let c = 0; c < ch; c++) {
          const s = src.getInt16(base + c * 2, true);
          const a = s < 0 ? -s : s;
          if (a > peak) peak = a;
          dst.setInt16(base + c * 2, s, true);
        }
        continue;
      }
      let loud = 0;
      for (let c = 0; c < ch; c++) {
        const s = src.getInt16(base + c * 2, true);
        const a = s < 0 ? -s : s;
        if (a > loud) loud = a;
      }
      const want = loud * gain > LIMIT_CEIL ? LIMIT_CEIL / (loud * gain) : 1;
      if (want < this.env) this.env = want;
      else this.env += (want - this.env) * this.release;
      if (this.env > 0.99999) this.env = 1;
      const g = gain * this.env;
      for (let c = 0; c < ch; c++) {
        let s = Math.round(src.getInt16(base + c * 2, true) * g);
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        dst.setInt16(base + c * 2, s, true);
      }
    }
    return { out, peak: Math.min(1, peak / 32768) };
  }
}

/** One-off gain with a fresh limiter, for callers without a stream. */
export function processPcm(chunk: Uint8Array, gain: number, channels = 2): { out: Uint8Array; peak: number } {
  return new Limiter(channels, 48_000).process(chunk, gain);
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
