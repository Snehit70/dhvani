/** What the panel draws: stereo meters plus a log-spaced spectrum, all 0..1. */
export type LevelFrame = {
  /** Post-gain peak, what the laptop actually plays (kept for older panels). */
  peak: number;
  /** Incoming peak and RMS per channel, before laptop volume. */
  l: number;
  r: number;
  rmsL: number;
  rmsR: number;
  /** Spectrum bands, -72..0 dBFS mapped to 0..1, low to high frequency. */
  bands: number[];
};

const FFT_N = 2048;
export const BANDS = 32;
const F_LO = 40;
const F_HI = 16000;
const FLOOR_DB = -72;

/**
 * Accumulates incoming s16le PCM between panel frames and turns it into meter
 * readings and a spectrum. Runs at most ~15 times a second, so a plain radix-2
 * FFT over the last 2048 samples costs well under a millisecond.
 */
export class Analyzer {
  private ring = new Float32Array(FFT_N);
  private pos = 0;
  private peakL = 0;
  private peakR = 0;
  private sumL = 0;
  private sumR = 0;
  private count = 0;
  private window = hann(FFT_N);
  private edges: number[];
  private re = new Float64Array(FFT_N);
  private im = new Float64Array(FFT_N);

  constructor(
    private rate: number,
    private channels: number,
  ) {
    this.edges = bandEdges(rate);
  }

  push(pcm: Uint8Array) {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length - (pcm.length % (2 * this.channels)));
    const frames = view.byteLength / (2 * this.channels);
    const stereo = this.channels === 2;
    for (let i = 0; i < frames; i++) {
      const l = view.getInt16(i * 2 * this.channels, true) / 32768;
      const r = stereo ? view.getInt16(i * 4 + 2, true) / 32768 : l;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.peakL) this.peakL = al;
      if (ar > this.peakR) this.peakR = ar;
      this.sumL += l * l;
      this.sumR += r * r;
      this.ring[this.pos] = (l + r) / 2;
      this.pos = (this.pos + 1) & (FFT_N - 1);
    }
    this.count += frames;
  }

  /** Readings since the last call; resets the meters, keeps the spectrum history. */
  frame(peak: number): LevelFrame {
    const n = Math.max(1, this.count);
    const out: LevelFrame = {
      peak: round(peak),
      l: round(this.peakL),
      r: round(this.peakR),
      rmsL: round(Math.sqrt(this.sumL / n)),
      rmsR: round(Math.sqrt(this.sumR / n)),
      bands: this.count ? this.spectrum() : new Array(BANDS).fill(0),
    };
    this.peakL = this.peakR = this.sumL = this.sumR = this.count = 0;
    return out;
  }

  private spectrum(): number[] {
    const { re, im, ring, window } = this;
    for (let i = 0; i < FFT_N; i++) {
      re[i] = ring[(this.pos + i) & (FFT_N - 1)]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    // Hann window halves the amplitude; a full-scale sine then reads about 0 dB.
    const scale = 4 / FFT_N;
    const bands: number[] = [];
    for (let b = 0; b < BANDS; b++) {
      const lo = this.edges[b]!;
      const hi = Math.max(lo + 1, this.edges[b + 1]!);
      let max = 0;
      for (let k = lo; k < hi && k < FFT_N / 2; k++) {
        const m = Math.hypot(re[k]!, im[k]!) * scale;
        if (m > max) max = m;
      }
      const db = max > 0 ? 20 * Math.log10(max) : FLOOR_DB;
      bands.push(round(Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB))));
    }
    return bands;
  }
}

/** FFT bin boundaries for BANDS log-spaced bands between F_LO and F_HI. */
export function bandEdges(rate: number): number[] {
  const hz = (b: number) => F_LO * (F_HI / F_LO) ** (b / BANDS);
  return Array.from({ length: BANDS + 1 }, (_, b) => Math.round((hz(b) * FFT_N) / rate));
}

function hann(n: number) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
