import { REDUNDANT_DELAY_MS } from "./protocol";

/** How long to wait for a missing packet's late copy before playing silence in its place. */
export const HOLE_WAIT_MS = REDUNDANT_DELAY_MS + 15;
/** Never hold more than this many packets behind a hole, whatever the clock says. */
const MAX_HELD = 32;

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
 * holds. A hole is waited on for at most HOLE_WAIT_MS.
 */
export class Reorder {
  private next = -1;
  private held = new Map<number, { pcm: Uint8Array; sentMs: number; late: boolean; at: number }>();
  private lastSize = 0;
  /** Totals since creation. */
  received = 0;
  recovered = 0;
  lost = 0;

  constructor(
    private deliver: (d: Delivered) => void,
    private now: () => number = () => performance.now(),
  ) {}

  push(seq: number, sentMs: number, late: boolean, pcm: Uint8Array) {
    if (this.next < 0) this.next = seq;
    // Already played (the copy of a packet that arrived fine) or already waiting.
    if (seq < this.next || this.held.has(seq)) return;
    this.received++;
    this.lastSize = pcm.length;
    if (seq === this.next) {
      this.emit(pcm, sentMs, late);
      this.next++;
      this.drain();
      return;
    }
    this.held.set(seq, { pcm, sentMs, late, at: this.now() });
    if (this.held.size > MAX_HELD) this.skipHole();
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
    let first = Infinity;
    for (const k of this.held.keys()) if (k < first) first = k;
    if (first === Infinity) return;
    const missing = first - this.next;
    this.lost += missing;
    for (let i = 0; i < missing; i++) {
      this.deliver({ pcm: new Uint8Array(this.lastSize), sentMs: null, recovered: false, concealed: true });
    }
    this.next = first;
    this.drain();
  }

  private drain() {
    for (let h = this.held.get(this.next); h; h = this.held.get(this.next)) {
      this.held.delete(this.next);
      this.emit(h.pcm, h.sentMs, h.late);
      this.next++;
    }
  }

  private emit(pcm: Uint8Array, sentMs: number, late: boolean) {
    if (late) this.recovered++;
    this.deliver({ pcm, sentMs, recovered: late, concealed: false });
  }
}
