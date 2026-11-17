import { describe, expect, test } from "bun:test";
import { FrameAligner, LeadLimiter, processPcm } from "../src/audio";
import { sanitize, defaults } from "../src/config";
import { FailureLimiter, codesMatch, isDiscoverRequest, parseHello, parsePhoneStats } from "../src/protocol";
import { StreamStats } from "../src/stats";

const hello = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, code: "123456", device: "Pixel", rate: 48000, channels: 2, format: "s16le", ...o });

describe("parseHello", () => {
  test("accepts a valid hello", () => {
    expect(parseHello(hello())).toMatchObject({ code: "123456", rate: 48000, channels: 2, device: "Pixel" });
  });
  test("rejects garbage and wrong versions/formats", () => {
    expect(parseHello("nope")).toEqual({ error: "bad_json" });
    expect(parseHello("null")).toEqual({ error: "bad_json" });
    expect(parseHello(hello({ v: 2 }))).toEqual({ error: "bad_version" });
    expect(parseHello(hello({ rate: 8000 }))).toEqual({ error: "bad_format" });
    expect(parseHello(hello({ channels: 6 }))).toEqual({ error: "bad_format" });
    expect(parseHello(hello({ code: 5 }))).toEqual({ error: "bad_code" });
  });
  test("trims device names", () => {
    expect(parseHello(hello({ device: "  " }))).toMatchObject({ device: "Phone" });
    expect((parseHello(hello({ device: "x".repeat(200) })) as { device: string }).device).toHaveLength(64);
  });
});

test("codesMatch", () => {
  expect(codesMatch("123456", "123456")).toBe(true);
  expect(codesMatch("123457", "123456")).toBe(false);
  expect(codesMatch("12345", "123456")).toBe(false);
  expect(codesMatch("1234567", "123456")).toBe(false);
});

test("discover request", () => {
  expect(isDiscoverRequest('{"dhvani":"discover","v":1}')).toBe(true);
  expect(isDiscoverRequest('{"x":1}')).toBe(false);
  expect(isDiscoverRequest("null")).toBe(false);
});

test("FailureLimiter blocks after repeated misses and expires", () => {
  let t = 0;
  const l = new FailureLimiter(3, 1000, () => t);
  l.fail("a"); l.fail("a");
  expect(l.blocked("a")).toBe(false);
  l.fail("a");
  expect(l.blocked("a")).toBe(true);
  expect(l.blocked("b")).toBe(false);
  t = 1000;
  expect(l.blocked("a")).toBe(false);
});

describe("audio", () => {
  const pcm = (...s: number[]) => {
    const b = new Uint8Array(s.length * 2);
    const v = new DataView(b.buffer);
    s.forEach((x, i) => v.setInt16(i * 2, x, true));
    return b;
  };
  const read = (b: Uint8Array) => {
    const v = new DataView(b.buffer, b.byteOffset, b.length);
    return Array.from({ length: b.length / 2 }, (_, i) => v.getInt16(i * 2, true));
  };
  test("gain clamps and reports peak", () => {
    const { out, peak } = processPcm(pcm(1000, -20000, 30000), 1.5);
    expect(read(out)).toEqual([1500, -30000, 32767]);
    expect(peak).toBeCloseTo(32767 / 32768);
    expect(read(processPcm(pcm(1000, -1000), 0).out)).toEqual([0, 0]);
  });
  test("FrameAligner keeps frames whole across chunks", () => {
    const a = new FrameAligner(4);
    const all = pcm(1, 2, 3, 4, 5, 6);
    const parts = [all.subarray(0, 3), all.subarray(3, 9), all.subarray(9)];
    const out = parts.map((p) => a.push(p));
    expect(out.map((o) => o.length)).toEqual([0, 8, 4]);
    expect(read(new Uint8Array([...out[1]!, ...out[2]!]))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

test("sanitize keeps values in range", () => {
  const base = defaults();
  const c = sanitize({ volume: 9, name: "  ", sink: 3 as unknown as string, code: "abc" }, base);
  expect(c.volume).toBe(1.5);
  expect(c.name).toBe(base.name);
  expect(c.sink).toBe(base.sink);
  expect(c.code).toBe(base.code);
});

test("LeadLimiter drops bursts beyond the lead and re-anchors after underruns", () => {
  let t = 0;
  const l = new LeadLimiter(1, 80, 30, () => t); // 1 byte per ms for easy maths
  // A 200 ms burst arrives at once: only ~80 ms worth (+ the chunk that crosses) is admitted.
  const admitted = Array.from({ length: 20 }, () => l.admit(10)).filter(Boolean).length;
  expect(admitted).toBe(9);
  // Steady real-time flow keeps the lead stable.
  for (let i = 0; i < 50; i++) { t += 10; expect(l.admit(10)).toBe(true); }
  expect(l.lead()).toBeCloseTo(90);
  // A long stall (player played silence) re-anchors rather than letting the deficit carry over.
  t += 500;
  expect(l.admit(10)).toBe(true);
  expect(l.lead()).toBeCloseTo(10);
});

test("StreamStats summarises arrival gaps, rate and drops per window", () => {
  let t = 0;
  const s = new StreamStats(() => t);
  for (let i = 0; i < 100; i++) { t += 10; s.arrival(1920); s.chunk(i % 2 ? 0.5 : 0, 20); }
  t += 150; s.arrival(1920); s.chunk(0.9, 60); // one Wi-Fi hiccup
  s.dropLate = 2;
  const w = s.flush(192_000);
  expect(w.gapMaxMs).toBe(150);
  expect(w.gaps100).toBe(1);
  expect(w.gapP50Ms).toBe(10);
  expect(w.ratePct).toBeCloseTo(87.8, 0); // 101 chunks in 1.15 s
  expect(w.dropLate).toBe(2);
  expect(w.leadMaxMs).toBe(60);
  expect(w.peakMax).toBe(0.9);
  expect(w.silentPct).toBeCloseTo(49.5, 0);
  expect(s.flush(192_000).gapMaxMs).toBe(0); // window resets
});

test("parsePhoneStats keeps only flat, bounded fields", () => {
  const r = parsePhoneStats(JSON.stringify({ dhvani: "stats", v: 1, code: "123456", rssi: -60, ok: true,
    model: "x".repeat(100), nested: { a: 1 }, "bad key": 1, inf: "y" }));
  expect(r?.code).toBe("123456");
  expect(r?.fields).toEqual({ rssi: -60, ok: true, model: "x".repeat(64), inf: "y" });
  expect(parsePhoneStats('{"dhvani":"discover"}')).toBeNull();
  expect(parsePhoneStats("nope")).toBeNull();
});
