/** A gap this long after an all-zero chunk is the phone idling, not the network. */
export const IDLE_GAP_MS = 60;

/** Per-window stream health counters, flushed to the log every few seconds. */
export class StreamStats {
  bytes = 0;
  chunks = 0;
  silentChunks = 0;
  dropLate = 0;
  dropStalled = 0;
  dropNoPlayer = 0;
  gapMaxMs = 0;
  gaps50 = 0;
  gaps100 = 0;
  leadMaxMs = 0;
  peakMax = 0;
  /** Time the phone held back data during silence (battery saver), excluded from gaps and rate. */
  idleMs = 0;
  private lastSilent = false;
  private gaps: number[] = [];
  private lastAt = 0;
  private windowStart: number;

  constructor(private now: () => number = () => performance.now()) {
    this.windowStart = now();
  }

  /** Called for every TCP data event, before processing. */
  arrival(bytes: number) {
    const t = this.now();
    const gap = this.lastAt ? t - this.lastAt : 0;
    if (this.lastSilent && gap > IDLE_GAP_MS) {
      // After an all-zero chunk the phone may pause sending on purpose; not a network gap.
      this.idleMs += gap;
    } else if (this.lastAt) {
      this.gaps.push(gap);
      if (gap > this.gapMaxMs) this.gapMaxMs = gap;
      if (gap > 50) this.gaps50++;
      if (gap > 100) this.gaps100++;
    }
    this.lastAt = t;
    this.bytes += bytes;
  }

  /** `silent`: the incoming chunk was all zeros (before laptop volume). */
  chunk(peak: number, leadMs: number, silent = peak === 0) {
    this.chunks++;
    if (silent) this.silentChunks++;
    this.lastSilent = silent;
    if (peak > this.peakMax) this.peakMax = peak;
    if (leadMs > this.leadMaxMs) this.leadMaxMs = leadMs;
  }

  /** Returns the window's summary and starts a new window. */
  flush(bytesPerSec: number): Record<string, number> {
    const t = this.now();
    const secs = Math.max(0.001, (t - this.windowStart) / 1000);
    const activeSecs = secs - this.idleMs / 1000;
    const sorted = this.gaps.sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0);
    const r = (n: number) => Math.round(n * 10) / 10;
    const out = {
      secs: r(secs),
      // 100 = data arrived exactly at the audio rate.
      // Measured only over time the phone was sending; mostly-idle windows read as on time.
      ratePct: activeSecs < 1 ? 100 : r((this.bytes / activeSecs / bytesPerSec) * 100),
      idlePct: r(Math.min(100, (this.idleMs / 1000 / secs) * 100)),
      gapP50Ms: r(pct(0.5)),
      gapP95Ms: r(pct(0.95)),
      gapMaxMs: r(this.gapMaxMs),
      gaps50: this.gaps50,
      gaps100: this.gaps100,
      dropLate: this.dropLate,
      dropStalled: this.dropStalled,
      dropNoPlayer: this.dropNoPlayer,
      leadMaxMs: r(this.leadMaxMs),
      peakMax: Math.round(this.peakMax * 1000) / 1000,
      silentPct: this.chunks ? r((this.silentChunks / this.chunks) * 100) : 0,
    };
    this.bytes = this.chunks = this.silentChunks = this.idleMs = 0;
    this.dropLate = this.dropStalled = this.dropNoPlayer = 0;
    this.gapMaxMs = this.gaps50 = this.gaps100 = this.leadMaxMs = this.peakMax = 0;
    this.gaps = [];
    this.windowStart = t;
    return out;
  }
}
