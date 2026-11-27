import type { Sink } from "./player";

/**
 * What to do with the output picked in the panel:
 * - ok: it is there (or none is pinned), play on it.
 * - fallback: it is gone, but the system output is another Bluetooth device (a second
 *   headset), so play there instead of going quiet.
 * - silent: it is gone and the system output may be the speakers, which are often far too
 *   loud at a volume set for headphones, so play silence until it is back.
 */
export type OutputState = { kind: "ok" } | { kind: "fallback"; sink: string; device: string } | { kind: "silent" };

/** A pinned output must be back this long before Dhvani returns to it; Bluetooth flaps while it reconnects. */
export const BACK_STABLE_MS = 4000;

/** Bluetooth outputs are usually worn; anything else may be the speakers. */
export const isBluetoothSink = (name: string) => name.startsWith("bluez_output.");

export class PinnedOutput {
  state: OutputState = { kind: "ok" };
  private presentSince = 0;

  /**
   * Feeds one look at PipeWire's sinks; returns true when the state changed.
   * An empty sink list means pactl failed, which says nothing, so the state stays.
   */
  update(pinned: string, sinks: Sink[], defaultSink: string, now: number): boolean {
    if (!pinned) return this.set({ kind: "ok" });
    if (!sinks.length) return false;
    if (sinks.some((s) => s.name === pinned)) {
      if (this.state.kind === "ok") return false;
      if (!this.presentSince) this.presentSince = now;
      if (now - this.presentSince < BACK_STABLE_MS) return false;
      return this.set({ kind: "ok" });
    }
    this.presentSince = 0;
    const def = sinks.find((s) => s.name === defaultSink);
    if (def && isBluetoothSink(def.name)) return this.set({ kind: "fallback", sink: def.name, device: def.description });
    return this.set({ kind: "silent" });
  }

  /** A new stream: a pinned output that came back while nothing played is used at once, no waiting. */
  sessionStarted() {
    this.presentSince = -Infinity;
  }

  /** The pinned output changed or was cleared. */
  reset() {
    this.presentSince = 0;
    this.state = { kind: "ok" };
  }

  private set(next: OutputState): boolean {
    this.presentSince = 0;
    if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
    this.state = next;
    return true;
  }
}
