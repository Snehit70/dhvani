// Wire protocol shared with the Android app (android/src/dev/snehit/dhvani/Protocol.java).
//
// Audio (TCP, AUDIO_PORT):
//   phone  -> laptop  one JSON line: {"v":1,"code":"123456","device":"Pixel","rate":48000,"channels":2,"format":"s16le"}
//   laptop -> phone   one JSON line: {"ok":true,"name":"fedora"} or {"ok":false,"error":"bad_code"}
//   phone  -> laptop  raw interleaved PCM until either side closes.
//   laptop -> phone   JSON lines while streaming: {"dhvani":"laptop","volume":1,"muted":false,"addresses":[...]}
//   Phone hello may carry "udp":1. The laptop then answers {"ok":true,"name","udp":{"port","token"}}
//   and the PCM travels as UDP audio packets (below) instead of over this socket, which stays
//   open as the session's control channel. The laptop writes {"dhvani":"ping"} on it every second,
//   and {"dhvani":"transport","udp":false} if no UDP audio arrives; the phone then sends PCM here.
//   A connection whose first line is a discover request gets one discover reply and is closed
//   (lets a phone find the laptop through `adb reverse` over USB, where UDP does not pass).
//
// Discovery (UDP broadcast, DISCOVERY_PORT):
//   phone  -> 255.255.255.255  {"dhvani":"discover","v":1}
//   laptop -> phone            {"dhvani":"here","v":1,"name":"fedora","port":47800}
//
// UDP audio (to DISCOVERY_PORT, which the firewall already opens), big-endian header:
//   0 'D' 'H' | 2 version 1 | 3 flags (bit 0: late copy of an earlier packet) | 4 token, 8 bytes
//   12 seq u32 | 16 phone clock ms u32 | 20 PCM, 5 ms (960 bytes at 48 kHz stereo)
//   Every packet is sent again REDUNDANT_DELAY_MS later, so a Wi-Fi loss shorter than that
//   costs nothing; a packet lost twice becomes 5 ms of silence instead of a TCP stall.
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
  /** The phone can send audio over UDP. */
  udp: boolean;
};

export type HelloError =
  | "bad_json"
  | "bad_version"
  | "bad_format"
  | "bad_code"
  | "rate_limited";

export type HelloReply =
  | { ok: true; name: string; udp?: { port: number; token: string } }
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
    udp: o.udp === 1 || o.udp === true,
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
/** Envelope and log keys a phone report may not set. */
const RESERVED_STATS_KEYS = new Set(["dhvani", "code", "v", "t", "ev", "session"]);

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
    if (RESERVED_STATS_KEYS.has(k) || !/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(k)) continue;
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
/** outputMissing: the laptop plays silence because its chosen output is gone (the phone says so). */
export function laptopState(volume: number, muted: boolean, addresses: string[], outputMissing = false): string {
  return JSON.stringify({ dhvani: "laptop", volume, muted, addresses, ...(outputMissing ? { outputMissing } : {}) }) + "\n";
}

export const UDP_HEADER = 20;
export const UDP_VERSION = 1;
export const UDP_TOKEN_BYTES = 8;
/** How long after the first copy the phone resends a packet. */
export const REDUNDANT_DELAY_MS = 20;

export type AudioPacket = { token: Uint8Array; seq: number; sentMs: number; late: boolean; pcm: Uint8Array };

export function isAudioPacket(b: Uint8Array): boolean {
  return b.length > UDP_HEADER && b[0] === 0x44 && b[1] === 0x48 && b[2] === UDP_VERSION;
}

export function parseAudioPacket(b: Uint8Array): AudioPacket | null {
  if (!isAudioPacket(b)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  return {
    token: b.subarray(4, 4 + UDP_TOKEN_BYTES),
    seq: v.getUint32(12),
    sentMs: v.getUint32(16),
    late: (b[3]! & 1) === 1,
    pcm: b.subarray(UDP_HEADER),
  };
}

export function encodeAudioPacket(p: { token: Uint8Array; seq: number; sentMs: number; late?: boolean; pcm: Uint8Array }): Uint8Array {
  const out = new Uint8Array(UDP_HEADER + p.pcm.length);
  const v = new DataView(out.buffer);
  out[0] = 0x44;
  out[1] = 0x48;
  out[2] = UDP_VERSION;
  out[3] = p.late ? 1 : 0;
  out.set(p.token.subarray(0, UDP_TOKEN_BYTES), 4);
  v.setUint32(12, p.seq >>> 0);
  v.setUint32(16, p.sentMs >>> 0);
  out.set(p.pcm, UDP_HEADER);
  return out;
}

export const PING_LINE = JSON.stringify({ dhvani: "ping" }) + "\n";
export const TCP_FALLBACK_LINE = JSON.stringify({ dhvani: "transport", udp: false }) + "\n";
/** UDP reaches the laptop again: go back to it. Phones before 0.7 ignore this and stay on TCP. */
export const UDP_RESUME_LINE = JSON.stringify({ dhvani: "transport", udp: true }) + "\n";
