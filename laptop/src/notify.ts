import { execFile } from "node:child_process";
import type { EndReason } from "./server";

export type Send = (title: string, body: string) => void;

/** Desktop notification through notify-send; silently does nothing where it is missing. */
export const notifySend: Send = (title, body) => {
  execFile("notify-send", ["-a", "Dhvani", "-i", "audio-headphones", "-u", "low", title, body], { timeout: 3000 }, () => {});
};

/** Ends the user caused or that a new session immediately follows: no notification. */
const QUIET_ENDS: ReadonlySet<EndReason> = new Set(["shutdown", "replaced", "code_changed", "disconnected"]);

/**
 * Turns session starts and ends into at most one notification per real change.
 * A drop is held for `graceMs`: if the phone reconnects within it (Wi-Fi blip,
 * auto-reconnect), neither the drop nor the reconnect is announced.
 */
export class SessionNotifier {
  private pending: { device: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private connected = new Set<string>();

  constructor(
    private send: Send,
    private enabled: () => boolean,
    private graceMs = 8000,
  ) {}

  started(device: string) {
    if (this.pending?.device === device) {
      clearTimeout(this.pending.timer);
      this.pending = null;
      this.connected.add(device);
      return;
    }
    if (this.connected.has(device)) return;
    this.connected.add(device);
    if (this.enabled()) this.send("Phone connected", `${device} is playing on this laptop.`);
  }

  ended(device: string, reason: EndReason) {
    if (reason === "replaced") return;
    if (QUIET_ENDS.has(reason)) {
      this.connected.delete(device);
      return;
    }
    if (this.pending) clearTimeout(this.pending.timer);
    const timer = setTimeout(() => {
      this.pending = null;
      this.connected.delete(device);
      if (!this.enabled()) return;
      this.send(
        "Phone disconnected",
        reason === "socket_error" || reason === "timeout" ? `Lost the connection to ${device}.` : `${device} stopped streaming.`,
      );
    }, this.graceMs);
    timer.unref?.();
    this.pending = { device, timer };
  }

  close() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
