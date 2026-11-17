// Wire protocol shared with the Android app (android/src/dev/snehit/dhvani/Protocol.java).
//
// Audio (TCP, AUDIO_PORT):
//   phone  -> laptop  one JSON line: {"v":1,"code":"123456","device":"Pixel","rate":48000,"channels":2,"format":"s16le"}
//   laptop -> phone   one JSON line: {"ok":true,"name":"fedora"} or {"ok":false,"error":"bad_code"}
//   phone  -> laptop  raw interleaved PCM until either side closes.
//   laptop -> phone   JSON lines while streaming: {"dhvani":"laptop","volume":1,"muted":false,"addresses":[...]}
//   A connection whose first line is a discover request gets one discover reply and is closed
//   (lets a phone find the laptop through `adb reverse` over USB, where UDP does not pass).
//
// Discovery (UDP broadcast, DISCOVERY_PORT):
//   phone  -> 255.255.255.255  {"dhvani":"discover","v":1}
//   laptop -> phone            {"dhvani":"here","v":1,"name":"fedora","port":47800}
//
// Phone reports (UDP to DISCOVERY_PORT, all carry the pairing code):
//   {"dhvani":"stats",...}    health counters every 10 s
//   {"dhvani":"volume",...}   phone media volume and mute
//   {"dhvani":"control","v":1,"code","volume"?:0..1.5,"muted"?:bool}  sets the laptop's own volume

export const PROTOCOL_VERSION = 1;
export const AUDIO_PORT = 47800;
export const UI_PORT = 47801;
export const DISCOVERY_PORT = 47802;
export const MAX_HELLO_BYTES = 2048;

export const SUPPORTED_RATES = [44100, 48000] as const;

export type Hello = {
  v: number;
  code: string;
  device: string;
  rate: number;
  channels: 1 | 2;
  format: "s16le";
};

export type HelloError =
  | "bad_json"
  | "bad_version"
  | "bad_format"
  | "bad_code"
  | "rate_limited";

export type HelloReply =
  | { ok: true; name: string }
  | { ok: false; error: HelloError };

export function parseHello(line: string): Hello | { error: HelloError } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: "bad_json" };
  }
  if (typeof raw !== "object" || raw === null) return { error: "bad_json" };
  const o = raw as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION) return { error: "bad_version" };
  if (typeof o.code !== "string") return { error: "bad_code" };
  if (
    o.format !== "s16le" ||
    !SUPPORTED_RATES.includes(o.rate as (typeof SUPPORTED_RATES)[number]) ||
    (o.channels !== 1 && o.channels !== 2)
  ) {
    return { error: "bad_format" };
  }
  const device =
    typeof o.device === "string" && o.device.trim()
      ? o.device.trim().slice(0, 64)
      : "Phone";
  return {
    v: PROTOCOL_VERSION,
    code: o.code,
    device,
    rate: o.rate as number,
    channels: o.channels as 1 | 2,
    format: "s16le",
  };
}

export function encodeReply(reply: HelloReply): string {
  return JSON.stringify(reply) + "\n";
}

/** Constant-time comparison so a wrong code leaks nothing through timing. */
export function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  return diff === 0;
}

export function isDiscoverRequest(msg: string): boolean {
  try {
    const o = JSON.parse(msg) as Record<string, unknown>;
    return o?.dhvani === "discover";
  } catch {
    return false;
  }
}

export function discoverReply(name: string, port: number): string {
  return JSON.stringify({ dhvani: "here", v: PROTOCOL_VERSION, name, port });
}

/** Wrong-code limiter: after `maxFails` misses an address waits `blockMs`. */
export class FailureLimiter {
  private entries = new Map<string, { fails: number; until: number }>();
  constructor(
    private maxFails = 5,
    private blockMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  blocked(addr: string): boolean {
    const e = this.entries.get(addr);
    if (!e) return false;
    if (e.until && this.now() >= e.until) {
      this.entries.delete(addr);
      return false;
    }
    return e.until > 0;
  }

  fail(addr: string): void {
    const e = this.entries.get(addr) ?? { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= this.maxFails) e.until = this.now() + this.blockMs;
    this.entries.set(addr, e);
  }

  succeed(addr: string): void {
    this.entries.delete(addr);
  }
}

/**
 * Phone-side health report sent over UDP while streaming. Returns the code it
 * claims plus only plain numeric/boolean/short-string fields, so a stray packet
 * cannot inject arbitrary structures into the log.
 */
export function parsePhoneStats(msg: string): { code: string; fields: Record<string, number | boolean | string> } | null {
  let o: unknown;
  try {
    o = JSON.parse(msg);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.dhvani !== "stats" || typeof r.code !== "string") return null;
  const fields: Record<string, number | boolean | string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(r)) {
    if (k === "dhvani" || k === "code" || k === "v" || !/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(k)) continue;
    if (++n > 32) break;
    if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
    else if (typeof v === "boolean") fields[k] = v;
    else if (typeof v === "string") fields[k] = v.slice(0, 64);
  }
  return { code: r.code, fields };
}

export type PhoneVolume = { code: string; index: number; max: number; muted: boolean };

/** Phone media volume report: {"dhvani":"volume","v":1,"code","index","max","muted"}. */
export function parsePhoneVolume(msg: string): PhoneVolume | null {
  let o: unknown;
  try {
    o = JSON.parse(msg);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.dhvani !== "volume" || typeof r.code !== "string") return null;
  const { index, max, muted } = r;
  if (!Number.isInteger(index) || !Number.isInteger(max) || typeof muted !== "boolean") return null;
  if ((max as number) < 1 || (max as number) > 1000 || (index as number) < 0 || (index as number) > (max as number)) return null;
  return { code: r.code, index: index as number, max: max as number, muted };
}

/** Lowest phone step maps to -45 dB; linear in dB like Android's own media curve. */
const PHONE_RANGE_DB = 45;

/** Gain the laptop applies for a phone volume step: 0 when muted or at zero, 1 at max. */
export function phoneGain(v: { index: number; max: number; muted: boolean }): number {
  if (v.muted || v.index <= 0) return 0;
  if (v.index >= v.max) return 1;
  return 10 ** ((-PHONE_RANGE_DB * (1 - v.index / v.max)) / 20);
}

export type PhoneControl = { code: string; volume?: number; muted?: boolean };

/** Phone asking to change the laptop's volume or mute. */
export function parseControl(msg: string): PhoneControl | null {
  let o: unknown;
  try {
    o = JSON.parse(msg);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.dhvani !== "control" || typeof r.code !== "string") return null;
  const out: PhoneControl = { code: r.code };
  if (typeof r.volume === "number" && Number.isFinite(r.volume)) out.volume = Math.min(1.5, Math.max(0, r.volume));
  if (typeof r.muted === "boolean") out.muted = r.muted;
  return out.volume === undefined && out.muted === undefined ? null : out;
}

/** Laptop state pushed down the audio socket so the phone can show and change it. */
export function laptopState(volume: number, muted: boolean, addresses: string[]): string {
  return JSON.stringify({ dhvani: "laptop", volume, muted, addresses }) + "\n";
}
