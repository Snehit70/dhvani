import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import { fromLinearVolume, type LatencyMode } from "./audio";

export type Config = {
  /** Six-digit code the phone must present. */
  code: string;
  /** PipeWire sink name; empty string follows the system default output. */
  sink: string;
  /** 0..1.5, shown as 0..150%. The gain is cubic in this (see volumeGain). */
  volume: number;
  /** "cubic" once `volume` is on the cubic scale; files without it hold a linear gain. */
  volumeScale: "cubic";
  muted: boolean;
  /** Scale output by the phone's own media volume (phone muted = laptop silent). */
  followPhone: boolean;
  /** Name the phone shows for this laptop. */
  name: string;
  /** "low": smallest delay, more dropouts on busy Wi-Fi. "stable": larger, adaptive buffer. */
  latency: LatencyMode;
  /** Desktop notifications when a phone connects or drops. */
  notify: boolean;
  /** Set up `adb reverse` for phones plugged in by USB, so audio can skip Wi-Fi. */
  usb: boolean;
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || ".", ".config");
  return process.env.DHVANI_CONFIG || join(base, "dhvani", "config.json");
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function defaults(): Config {
  return {
    code: newCode(), sink: "", volume: 1, volumeScale: "cubic", muted: false, followPhone: true, name: hostname(),
    latency: "stable", notify: true, usb: true,
  };
}

export function sanitize(input: Partial<Config>, base: Config): Config {
  const c = { ...base };
  if (typeof input.code === "string" && /^\d{6}$/.test(input.code)) c.code = input.code;
  if (typeof input.sink === "string" && input.sink.length < 256) c.sink = input.sink;
  if (typeof input.volume === "number" && Number.isFinite(input.volume)) {
    c.volume = Math.min(1.5, Math.max(0, input.volume));
  }
  if (typeof input.muted === "boolean") c.muted = input.muted;
  if (typeof input.followPhone === "boolean") c.followPhone = input.followPhone;
  if (typeof input.name === "string" && input.name.trim()) c.name = input.name.trim().slice(0, 40);
  if (input.latency === "low" || input.latency === "stable") c.latency = input.latency;
  if (typeof input.notify === "boolean") c.notify = input.notify;
  if (typeof input.usb === "boolean") c.usb = input.usb;
  return c;
}

export function loadConfig(path = configPath()): Config {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    const merged = sanitize(raw, defaults());
    // Up to 0.8 the volume was a linear gain; move it to the cubic scale at the same loudness.
    const linear = raw.volumeScale !== "cubic";
    if (linear) merged.volume = fromLinearVolume(merged.volume);
    if (raw.code !== merged.code || linear) saveConfig(merged, path);
    return merged;
  } catch {
    const fresh = defaults();
    saveConfig(fresh, path);
    return fresh;
  }
}

export function saveConfig(c: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
