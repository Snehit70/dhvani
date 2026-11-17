// Wire protocol shared with the Android app (android/src/dev/snehit/dhvani/Protocol.java).
//
// Audio (TCP, AUDIO_PORT):
//   phone  -> laptop  one JSON line: {"v":1,"code":"123456","device":"Pixel","rate":48000,"channels":2,"format":"s16le"}
//   laptop -> phone   one JSON line: {"ok":true,"name":"fedora"} or {"ok":false,"error":"bad_code"}
//   phone  -> laptop  raw interleaved PCM until either side closes.
//
// Discovery (UDP broadcast, DISCOVERY_PORT):
//   phone  -> 255.255.255.255  {"dhvani":"discover","v":1}
//   laptop -> phone            {"dhvani":"here","v":1,"name":"fedora","port":47800}

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
