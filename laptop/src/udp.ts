import { REDUNDANT_DELAY_MS } from "./protocol";

/** How long to wait for a missing packet's late copy before playing silence in its place. */
export const HOLE_WAIT_MS = REDUNDANT_DELAY_MS + 15;
/** Never hold more than this many packets behind a hole, whatever the clock says. */
const MAX_HELD = 32;
/**
 * Holes up to this many packets (100 ms) are filled in full so playback timing holds. A longer
 * hole means the output already ran dry: it gets only the short fade-out, and the jitter buffer
 * restarts cleanly instead of queuing 100 ms of silence after the outage is already over.
 */
export const MAX_CONCEAL = 20;
/** A sequence jump this large either way (10 s of packets) is a new run from the phone, not a hole. */
export const MAX_JUMP = 2000;
/** Fade-in on the first real packet after concealed ones, in frames (2.5 ms at 48 kHz). */
const FADE_IN_FRAMES = 120;

/** a - b on the u32 sequence circle: negative when a is before b, also across the wrap. */
export function seqDiff(a: number, b: number): number {
  return (a - b) | 0;
}

export type Delivered = {
  pcm: Uint8Array;
  /** Phone clock when the first copy left, ms (null for concealed silence). */
  sentMs: number | null;
  /** Filled from the late copy because the first one was lost. */
  recovered: boolean;
  /** Silence standing in for a packet lost twice. */
  concealed: boolean;
};

/**
 * Puts UDP audio packets back in order, drops duplicates, uses a packet's late copy
 * when the first was lost, and fills packets lost twice with silence so playback timing
 * holds. A hole is waited on for at most HOLE_WAIT_MS. Sequence numbers are u32 and wrap.
 */
export class Reorder {
  private next = -1;
  private held = new Map<number, { pcm: Uint8Array; sentMs: number; late: boolean; at: number }>();
  private lastSize = 0;
  private lastPcm: Uint8Array | null = null;
  /** The previous delivery was concealment, so the next real packet fades in. */
  private afterHole = false;
  /** Totals since creation. */
  received = 0;
  recovered = 0;
  lost = 0;

  constructor(
    private deliver: (d: Delivered) => void,
    private now: () => number = () => performance.now(),
    private channels = 2,
  ) {}

  /** Forget the sequence (the phone switched transports and back); totals stay. */
  reset() {
    this.next = -1;
    this.held.clear();
    this.lastPcm = null;
  }

  /** True if the packet was new: not a copy of one already played or waiting. */
  push(seq: number, sentMs: number, late: boolean, pcm: Uint8Array): boolean {
    seq >>>= 0;
    if (this.next >= 0 && Math.abs(seqDiff(seq, this.next)) > MAX_JUMP) {
      // The phone restarted its count: start over rather than conceal or ignore a giant gap.
      this.reset();
      this.afterHole = true;
    }
    if (this.next < 0) this.next = seq;
    // Already played (the copy of a packet that arrived fine) or already waiting.
    if (seqDiff(seq, this.next) < 0 || this.held.has(seq)) return false;
    this.received++;
    this.lastSize = pcm.length;
    if (seq === this.next) {
      this.emit(pcm, sentMs, late);
      this.next = (this.next + 1) >>> 0;
      this.drain();
      return true;
    }
    this.held.set(seq, { pcm, sentMs, late, at: this.now() });
    if (this.held.size > MAX_HELD) this.skipHole();
    return true;
  }

  /** Call every few ms: gives up on a hole once its late copy is overdue. */
  tick() {
    if (!this.held.size) return;
    const t = this.now();
    let oldest = Infinity;
    for (const h of this.held.values()) if (h.at < oldest) oldest = h.at;
    if (t - oldest >= HOLE_WAIT_MS) this.skipHole();
  }

  private skipHole() {
    let first = -1;
    let missing = Infinity;
    for (const k of this.held.keys()) {
      const d = seqDiff(k, this.next);
      if (d < missing) {
        missing = d;
        first = k;
      }
    }
    if (first < 0) return;
    this.lost += missing;
    const fill = missing <= MAX_CONCEAL ? missing : 1;
    for (let i = 0; i < fill; i++) {
      // The first stand-in plays the last packet backwards, fading out: it starts on the sample
      // the audio stopped at, so the hole is heard as a short dip instead of a click.
      const pcm = i === 0 && this.lastPcm ? fadeOutReversed(this.lastPcm, this.channels) : new Uint8Array(this.lastSize);
      this.deliver({ pcm, sentMs: null, recovered: false, concealed: true });
    }
    this.afterHole = true;
    this.next = first;
    this.drain();
  }

  private drain() {
    for (let h = this.held.get(this.next); h; h = this.held.get(this.next)) {
      this.held.delete(this.next);
      this.emit(h.pcm, h.sentMs, h.late);
      this.next = (this.next + 1) >>> 0;
    }
  }

  private emit(pcm: Uint8Array, sentMs: number, late: boolean) {
    if (late) this.recovered++;
    if (this.afterHole) {
      pcm = fadeIn(pcm, this.channels, FADE_IN_FRAMES);
      this.afterHole = false;
    }
    this.lastPcm = pcm;
    this.deliver({ pcm, sentMs, recovered: late, concealed: false });
  }
}

/** The packet's frames in reverse order, faded linearly to silence. */
export function fadeOutReversed(pcm: Uint8Array, channels: number): Uint8Array {
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = new Uint8Array(pcm.length);
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const dst = new DataView(out.buffer);
  for (let f = 0; f < frames; f++) {
    const g = 1 - (f + 1) / frames;
    const from = (frames - 1 - f) * channels * 2;
    for (let c = 0; c < channels; c++) {
      dst.setInt16(f * channels * 2 + c * 2, Math.round(src.getInt16(from + c * 2, true) * g), true);
    }
  }
  return out;
}

/** A copy with the first `n` frames faded in from silence. */
export function fadeIn(pcm: Uint8Array, channels: number, n: number): Uint8Array {
  const out = pcm.slice();
  const frames = Math.min(n, Math.floor(pcm.length / (2 * channels)));
  const v = new DataView(out.buffer);
  for (let f = 0; f < frames; f++) {
    const g = f / frames;
    for (let c = 0; c < channels; c++) {
      const o = f * channels * 2 + c * 2;
      v.setInt16(o, Math.round(v.getInt16(o, true) * g), true);
    }
  }
  return out;
}

/** Packets this far behind for this long mean the phone's clock jumped, not a backlog. */
const STALE_STREAK_MS = 1000;
/** The transit floor is the smallest of the last two windows of this length (clock drift). */
const FLOOR_WINDOW_MS = 10_000;

/**
 * Spots packets that arrive long after they were sent, such as the backlog a Wi-Fi stall
 * releases at once. Playing those first means hearing old audio and then skipping ahead;
 * dropping them jumps straight back to live audio. Delay is measured against the smallest
 * transit seen recently, so the two clocks need not agree.
 */
export class StaleGate {
  private ref: number | null = null;
  private cur = Infinity;
  private prev = Infinity;
  private rotateAt = 0;
  private streakSince = -1;
  /** Packets dropped as stale, total. */
  dropped = 0;

  /** True when the packet sent at phone time `sentMs` is more than `limitMs` behind. */
  stale(sentMs: number, now: number, limitMs: number): boolean {
    const tr = now - sentMs;
    if (this.ref === null) {
      this.ref = tr;
      this.rotateAt = now + FLOOR_WINDOW_MS;
    }
    // The phone clock is 32-bit and wraps; keep transits relative to the first one.
    const wrap = 2 ** 32;
    let d = (tr - this.ref) % wrap;
    if (d > wrap / 2) d -= wrap;
    if (d < -wrap / 2) d += wrap;
    if (now >= this.rotateAt) {
      this.prev = this.cur;
      this.cur = Infinity;
      this.rotateAt = now + FLOOR_WINDOW_MS;
    }
    if (d < this.cur) this.cur = d;
    const floor = Math.min(this.cur, this.prev);
    if (d - floor <= limitMs) {
      this.streakSince = -1;
      return false;
    }
    if (this.streakSince < 0) this.streakSince = now;
    if (now - this.streakSince > STALE_STREAK_MS) {
      this.cur = this.prev = d;
      this.streakSince = -1;
      return false;
    }
    this.dropped++;
    return true;
  }
}
