/** Loudest sample the limiter lets through, about -0.4 dBFS. */
const LIMIT_CEIL = 31_130;
/** How long the limiter takes to give gain back after a peak. */
const LIMIT_RELEASE_MS = 80;
/** A volume or mute change glides over this long; a jump at a chunk boundary clicks on loud audio. */
export const GAIN_RAMP_MS = 5;

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
  private readonly rampFrames: number;
  /** Gain in effect now, moving toward `target` by `step` per frame. Null until the first chunk. */
  private cur: number | null = null;
  private target = 1;
  private step = 0;
  constructor(private readonly channels: number, rate: number) {
    this.release = 1 - Math.exp(-1 / ((LIMIT_RELEASE_MS / 1000) * rate));
    this.rampFrames = Math.max(1, Math.round((GAIN_RAMP_MS / 1000) * rate));
  }
  process(chunk: Uint8Array, gain: number): { out: Uint8Array; peak: number } {
    const ch = Math.max(1, this.channels);
    const frames = Math.floor(chunk.length / (2 * ch));
    const out = new Uint8Array(frames * ch * 2);
    const src = new DataView(chunk.buffer, chunk.byteOffset, frames * ch * 2);
    const dst = new DataView(out.buffer);
    let peak = 0;
    if (this.cur === null) this.cur = this.target = gain;
    else if (gain !== this.target) {
      this.target = gain;
      this.step = (gain - this.cur) / this.rampFrames;
    }
    const unity = gain === 1 && this.cur === 1 && this.env === 1;
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
      if (this.cur !== this.target) {
        this.cur += this.step;
        if (this.step > 0 ? this.cur >= this.target : this.cur <= this.target) this.cur = this.target;
      }
      const level = this.cur;
      let loud = 0;
      for (let c = 0; c < ch; c++) {
        const s = src.getInt16(base + c * 2, true);
        const a = s < 0 ? -s : s;
        if (a > loud) loud = a;
      }
      const want = loud * level > LIMIT_CEIL ? LIMIT_CEIL / (loud * level) : 1;
      if (want < this.env) this.env = want;
      else this.env += (want - this.env) * this.release;
      if (this.env > 0.99999) this.env = 1;
      const g = level * this.env;
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

/** Below this setting (10%, -60 dB) the curve stops being cubic. */
const CUBIC_KNEE = 0.1;
/** Gain just above 0%, in dB. */
const FLOOR_DB = -80;

/**
 * Gain for a volume setting (0..1.5, the number the panel and the phone show). Cubic, like
 * PipeWire's own volume, so equal slider moves sound like equal steps: 50% is about -18 dB,
 * 100% unity, 150% about +10.6 dB. A linear scale made 5-15% loud and 100-150% barely louder.
 * Under 10% the cube drops faster than 16-bit audio can follow (1% is -120 dB, so every sample
 * rounds to 0), so there it falls evenly in dB from -60 to -80 instead.
 */
export function volumeGain(volume: number): number {
  if (!(volume > 0)) return 0;
  if (volume >= CUBIC_KNEE) return volume ** 3;
  return 10 ** ((FLOOR_DB + (volume / CUBIC_KNEE) * (-60 - FLOOR_DB)) / 20);
}

/** Converts a setting saved on the old linear scale to the cubic one, keeping the same loudness. */
export function fromLinearVolume(volume: number): number {
  return Math.round(Math.cbrt(Math.min(1.5, Math.max(0, volume))) * 100) / 100;
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

/** How long a splice is smoothed over, in frames (2 ms at 48 kHz). */
export const DECLICK_FRAMES = 96;

/**
 * Smooths a join where audio was skipped or silence was put in. The jump from the last
 * sample written to the first new one would click, so an offset that starts at that jump
 * and fades to zero is added over the first `n` frames. Changes `pcm` in place.
 */
export function declick(pcm: Uint8Array, last: number[], channels: number, n = DECLICK_FRAMES) {
  const frames = Math.min(n, Math.floor(pcm.length / (2 * channels)));
  if (!frames) return;
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const jump = last.map((x, c) => x - v.getInt16(c * 2, true));
  for (let f = 0; f < frames; f++) {
    const g = 1 - f / frames;
    for (let c = 0; c < channels; c++) {
      const o = f * channels * 2 + c * 2;
      let s = Math.round(v.getInt16(o, true) + jump[c]! * g);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      v.setInt16(o, s, true);
    }
  }
}

/** The last frame's samples, one per channel. */
export function lastFrame(pcm: Uint8Array, channels: number): number[] | null {
  const frames = Math.floor(pcm.length / (2 * channels));
  if (!frames) return null;
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const base = (frames - 1) * channels * 2;
  return Array.from({ length: channels }, (_, c) => v.getInt16(base + c * 2, true));
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
  low: { minMs: 50, maxMs: 200 },
  stable: { minMs: 100, maxMs: 300 },
};

/** Buffer floor while the phone screen is off and Android lets Wi-Fi power save kick in. */
export const SCREEN_OFF_FLOOR_MS = 80;

export function latencyBounds(mode: LatencyMode, screenOff = false): { minMs: number; maxMs: number } {
  const b = LATENCY[mode];
  if (!screenOff) return b;
  return { minMs: Math.max(b.minMs, SCREEN_OFF_FLOOR_MS), maxMs: Math.max(b.maxMs, SCREEN_OFF_FLOOR_MS + 70) };
}

/** Post-gain peak below this (about -54 dBFS) counts as silence. */
export const QUIET_PEAK = 0.002;

/**
 * play: write it. compress: write it through the Accelerator and report what was written
 * with `wrote()`. quiet: near-silent excess, dropped unheard. late: past the hard cap.
 */
export type AdmitMode = "play" | "compress" | "quiet" | "late";
export type Admit = { play: boolean; prefillMs: number; mode: AdmitMode };

/**
 * Adaptive jitter buffer in front of the player. It tracks how far the audio
 * written runs ahead of the wall clock ("lead").
 *
 * - Start, and restart after the player ran dry: write `targetMs` of silence
 *   first, so the next Wi-Fi hiccup up to that size is absorbed instead of heard.
 *   Later, a quiet chunk well short of target tops the buffer back up the same way.
 * - A dry spell after audible audio counts as an underrun and raises the target
 *   (one after silence is the phone pausing to save battery and is ignored).
 * - The target relaxes back toward the minimum after a calm spell.
 * - Excess lead is shed in quiet chunks, where dropping is inaudible. Audible excess is
 *   played slightly faster (see Accelerator), and only a burst past target + headroom
 *   is dropped outright.
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
  static readonly MAX_STEP_MS = 60;
  static readonly RELAX_AFTER_MS = 30_000;
  static readonly RELAX_STEP_MS = 10;
  static readonly DRY_MS = 20;
  static readonly DRAIN_MS = 30;
  static readonly HEADROOM_MS = 200;

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
        // Grow by how long the output actually ran dry, so one deep stall is covered next time
        // instead of after several more underruns of 20 ms steps.
        const dry = Math.min(JitterBuffer.MAX_STEP_MS, Math.max(JitterBuffer.STEP_MS, -this.lead(t)));
        this.targetMs = Math.min(this.bounds.maxMs, this.targetMs + Math.round(dry));
        this.lastChange = t;
      }
      this.anchor = t;
      this.writtenMs = prefillMs = this.targetMs;
    } else if (t - this.lastChange > JitterBuffer.RELAX_AFTER_MS && this.targetMs > this.bounds.minMs) {
      this.targetMs = Math.max(this.bounds.minMs, this.targetMs - JitterBuffer.RELAX_STEP_MS);
      this.lastChange = t;
    }
    this.lastQuiet = quiet;
    // Short of target (it was just raised): top up with silence where it can't be heard.
    if (quiet && prefillMs === 0 && this.lead(t) < this.targetMs - JitterBuffer.DRAIN_MS) {
      prefillMs = this.targetMs - this.lead(t);
      this.writtenMs += prefillMs;
    }
    const lead = this.lead(t);
    if (lead > this.targetMs + JitterBuffer.HEADROOM_MS) return { play: false, prefillMs, mode: "late" };
    if (lead > this.targetMs + JitterBuffer.DRAIN_MS) {
      if (quiet) return { play: false, prefillMs, mode: "quiet" };
      return { play: true, prefillMs, mode: "compress" };
    }
    this.writtenMs += bytes / this.bytesPerMs;
    return { play: true, prefillMs, mode: "play" };
  }

  /** Accounts audio written outside admit(), after compression. */
  wrote(bytes: number) {
    this.writtenMs += bytes / this.bytesPerMs;
  }

  /** Milliseconds of audio queued ahead of real time. */
  lead(t = this.now()): number {
    return this.anchor < 0 ? 0 : this.writtenMs - (t - this.anchor);
  }
}
