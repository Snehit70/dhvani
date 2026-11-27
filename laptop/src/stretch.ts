/**
 * Sheds excess buffered delay by playing audio slightly faster instead of dropping
 * whole chunks, the way WebRTC's NetEQ "accelerate" does. It gathers BLOCK_MS of audio,
 * finds the cut length (2.5-10 ms) where the audio after the cut best matches the audio
 * before it, and splices the two with a short crossfade. For tonal sound the best cut is
 * a whole number of pitch periods, so the splice is close to seamless and pitch is kept.
 */
export const BLOCK_MS = 40;
const OVERLAP_MS = 2.5;
const MIN_CUT_MS = 2.5;
const MAX_CUT_MS = 10;
/** Below this match quality a cut would be heard; the block plays unchanged instead. */
const MIN_CORRELATION = 0.6;
/** Blocks this quiet (about -50 dBFS RMS) are cut at full length without searching. */
const QUIET_RMS = 100;

export class Accelerator {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly frameBytes: number;
  private readonly blockFrames: number;
  private readonly overlap: number;
  private readonly minCut: number;
  private readonly maxCut: number;
  /** Total audio removed, ms. */
  removedMs = 0;

  constructor(private readonly channels: number, private readonly rate: number) {
    this.frameBytes = Math.max(1, channels) * 2;
    const f = (ms: number) => Math.round((ms * rate) / 1000);
    this.blockFrames = f(BLOCK_MS);
    this.overlap = f(OVERLAP_MS);
    this.minCut = f(MIN_CUT_MS);
    this.maxCut = f(MAX_CUT_MS);
  }

  /** Audio held back while a block fills. */
  get pendingMs(): number {
    return (this.pendingBytes / this.frameBytes / this.rate) * 1000;
  }

  /** Queues a chunk; returns whatever is ready to play now, shortened where possible. */
  push(pcm: Uint8Array): Uint8Array {
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    const blockBytes = this.blockFrames * this.frameBytes;
    if (this.pendingBytes < blockBytes) return new Uint8Array(0);
    const all = this.take();
    const whole = Math.floor(all.length / blockBytes) * blockBytes;
    const parts: Uint8Array[] = [];
    for (let off = 0; off < whole; off += blockBytes) parts.push(this.shorten(all.subarray(off, off + blockBytes)));
    if (whole < all.length) {
      const rest = all.slice(whole);
      this.pending = [rest];
      this.pendingBytes = rest.length;
    }
    return concat(parts);
  }

  /** Returns held audio unchanged, e.g. once the buffer is back on target. */
  flush(): Uint8Array {
    return this.take();
  }

  /**
   * Forgets held audio, for a discontinuity (skip, drop, stall): playing it later would put
   * old audio after newer audio. It was excess delay being shed anyway. Returns ms dropped.
   */
  drop(): number {
    const ms = this.pendingMs;
    this.pending = [];
    this.pendingBytes = 0;
    return ms;
  }

  private take(): Uint8Array {
    const out = concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    return out;
  }

  /** One block in, the block minus one spliced-out stretch out (or unchanged). */
  shorten(block: Uint8Array): Uint8Array {
    const ch = Math.max(1, this.channels);
    const frames = Math.floor(block.length / this.frameBytes);
    const v = new DataView(block.buffer, block.byteOffset, frames * this.frameBytes);
    const mono = new Float32Array(frames);
    // Energy per channel, not of the mix: channels in opposite phase cancel in `mono` but are loud.
    let energy = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let c = 0; c < ch; c++) {
        const x = v.getInt16((f * ch + c) * 2, true);
        s += x;
        energy += (x * x) / ch;
      }
      mono[f] = s / ch;
    }
    const W = this.overlap;
    const maxCut = Math.min(this.maxCut, frames - W);
    if (maxCut < this.minCut) return block;
    let cut = maxCut;
    if (Math.sqrt(energy / frames) >= QUIET_RMS) {
      let best = -1;
      let aa = 0;
      for (let i = 0; i < W; i++) aa += mono[i]! * mono[i]!;
      for (let L = this.minCut; L <= maxCut; L++) {
        let ab = 0, bb = 0;
        for (let i = 0; i < W; i++) {
          const b = mono[L + i]!;
          ab += mono[i]! * b;
          bb += b * b;
        }
        const c = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
        if (c > best) {
          best = c;
          cut = L;
        }
      }
      if (best < MIN_CORRELATION) return block;
    }
    const outFrames = frames - cut;
    const out = new Uint8Array(outFrames * this.frameBytes);
    const o = new DataView(out.buffer);
    for (let f = 0; f < W; f++) {
      const w = (f + 0.5) / W;
      for (let c = 0; c < ch; c++) {
        const a = v.getInt16((f * ch + c) * 2, true);
        const b = v.getInt16(((f + cut) * ch + c) * 2, true);
        o.setInt16((f * ch + c) * 2, Math.round(a * (1 - w) + b * w), true);
      }
    }
    out.set(block.subarray((W + cut) * this.frameBytes, frames * this.frameBytes), W * this.frameBytes);
    this.removedMs += (cut / this.rate) * 1000;
    return out;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
