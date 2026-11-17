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

/**
 * Keeps playback close to real time. Tracks how far the audio written to the
 * player runs ahead of the wall clock; chunks beyond `maxLeadMs` are dropped
 * (so Wi-Fi bursts and phone/headset clock drift cannot pile up delay), and an
 * underrun re-anchors the clock because the player already filled the gap with silence.
 */
export class LeadLimiter {
  private anchor = -1;
  private writtenMs = 0;
  constructor(
    private bytesPerMs: number,
    private maxLeadMs = 80,
    private underrunMs = 30,
    private now: () => number = () => performance.now(),
  ) {}

  /** Returns true if a chunk of `bytes` should be played, false to drop it. */
  admit(bytes: number): boolean {
    const t = this.now();
    if (this.anchor < 0 || this.lead(t) < -this.underrunMs) {
      this.anchor = t;
      this.writtenMs = 0;
    }
    if (this.lead(t) > this.maxLeadMs) return false;
    this.writtenMs += bytes / this.bytesPerMs;
    return true;
  }

  /** Milliseconds of audio queued ahead of real time. */
  lead(t = this.now()): number {
    return this.anchor < 0 ? 0 : this.writtenMs - (t - this.anchor);
  }
}
