import { describe, expect, test } from "bun:test";
import { FrameAligner, JitterBuffer, processPcm } from "../src/audio";
import { SessionNotifier } from "../src/notify";
import { usbSerials } from "../src/usb";
import { sanitize, defaults } from "../src/config";
import { FailureLimiter, codesMatch, isDiscoverRequest, parseHello, parseControl, parsePhoneStats, parsePhoneVolume, phoneGain } from "../src/protocol";
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

test("JitterBuffer prefills its target so a Wi-Fi hiccup does not run dry", () => {
  let t = 0;
  const b = new JitterBuffer(1, { minMs: 100, maxMs: 300 }, () => t); // 1 byte per ms
  expect(b.admit(10)).toEqual({ play: true, prefillMs: 100 });
  for (let i = 0; i < 20; i++) { t += 10; b.admit(10); }
  // 110 ms with nothing, then the backlog arrives at once: no underrun, nothing dropped.
  t += 110;
  const burst = Array.from({ length: 11 }, () => b.admit(10));
  expect(burst.every((a) => a.play && a.prefillMs === 0)).toBe(true);
  expect(b.underruns).toBe(0);
});

test("JitterBuffer grows after an audible underrun, ignores ones after silence, and relaxes", () => {
  let t = 0;
  const b = new JitterBuffer(1, { minMs: 100, maxMs: 300 }, () => t);
  b.admit(10);
  t += 400; // dry after audible audio
  expect(b.admit(10).prefillMs).toBe(120);
  expect(b.underruns).toBe(1);
  b.admit(10, true);
  t += 2000; // phone paused sending during silence
  b.admit(10);
  expect(b.underruns).toBe(1);
  expect(b.targetMs).toBe(120);
  for (let i = 0; i < 3100; i++) { t += 10; b.admit(10); }
  expect(b.targetMs).toBe(110);
});

test("JitterBuffer sheds excess lead only in quiet chunks, with a hard cap", () => {
  let t = 0;
  const b = new JitterBuffer(1, { minMs: 100, maxMs: 300 }, () => t);
  b.admit(10); // lead 110
  for (let i = 0; i < 3; i++) b.admit(10); // burst: lead 140
  expect(b.admit(10, true).play).toBe(false); // quiet and above target + 30: dropped
  expect(b.admit(10, false).play).toBe(true); // audible: kept
  const r = Array.from({ length: 20 }, () => b.admit(10, false).play);
  expect(r.filter(Boolean).length).toBe(6); // 150..200 ms admitted, then capped at target + 100
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

test("parsePhoneVolume validates shape and bounds", () => {
  const ok = { dhvani: "volume", v: 1, code: "123456", index: 7, max: 15, muted: false };
  expect(parsePhoneVolume(JSON.stringify(ok))).toEqual({ code: "123456", index: 7, max: 15, muted: false });
  expect(parsePhoneVolume(JSON.stringify({ ...ok, dhvani: "stats" }))).toBeNull();
  expect(parsePhoneVolume(JSON.stringify({ ...ok, index: 16 }))).toBeNull();
  expect(parsePhoneVolume(JSON.stringify({ ...ok, index: 1.5 }))).toBeNull();
  expect(parsePhoneVolume(JSON.stringify({ ...ok, max: 0 }))).toBeNull();
  expect(parsePhoneVolume(JSON.stringify({ ...ok, muted: "no" }))).toBeNull();
  expect(parsePhoneVolume("not json")).toBeNull();
});

test("phoneGain: mute and zero are silent, max is unity, steps are monotonic", () => {
  expect(phoneGain({ index: 15, max: 15, muted: true })).toBe(0);
  expect(phoneGain({ index: 0, max: 15, muted: false })).toBe(0);
  expect(phoneGain({ index: 15, max: 15, muted: false })).toBe(1);
  let prev = 0;
  for (let i = 1; i <= 15; i++) {
    const g = phoneGain({ index: i, max: 15, muted: false });
    expect(g).toBeGreaterThan(prev);
    prev = g;
  }
  expect(phoneGain({ index: 1, max: 15, muted: false })).toBeLessThan(0.01);
});

test("parseControl clamps volume and needs at least one change", () => {
  expect(parseControl(JSON.stringify({ dhvani: "control", code: "1", volume: 9 }))).toEqual({ code: "1", volume: 1.5 });
  expect(parseControl(JSON.stringify({ dhvani: "control", code: "1", muted: true }))).toEqual({ code: "1", muted: true });
  expect(parseControl(JSON.stringify({ dhvani: "control", code: "1" }))).toBeNull();
  expect(parseControl(JSON.stringify({ dhvani: "control", volume: 1 }))).toBeNull();
});

test("usbSerials keeps cable-attached phones only", () => {
  const out = "List of devices attached\nABC123\tdevice\n192.168.1.5:5555\tdevice\n" +
    "adb-XYZ._adb-tls-connect._tcp\tdevice\nDEF456\tunauthorized\n";
  expect(usbSerials(out)).toEqual(["ABC123"]);
});

test("SessionNotifier: one notice per real change, blips within grace are silent", async () => {
  const sent: string[] = [];
  const n = new SessionNotifier((title) => sent.push(title), () => true, 30);
  n.started("Pixel");
  n.ended("Pixel", "socket_error");
  n.started("Pixel"); // reconnected within grace
  await Bun.sleep(50);
  expect(sent).toEqual(["Phone connected"]);
  n.ended("Pixel", "phone_closed");
  await Bun.sleep(50);
  expect(sent).toEqual(["Phone connected", "Phone disconnected"]);
  n.started("Pixel");
  n.ended("Pixel", "disconnected"); // user pressed Disconnect: no notice
  await Bun.sleep(50);
  expect(sent).toEqual(["Phone connected", "Phone disconnected", "Phone connected"]);
});

test("Analyzer: a 1 kHz tone lights the 1 kHz band, meters read the channel peaks", () => {
  const { Analyzer, bandEdges, BANDS } = require("../src/analyzer") as typeof import("../src/analyzer");
  const rate = 48000, n = 4096, pcm = new Uint8Array(n * 4), v = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 16384);
    v.setInt16(i * 4, s, true);
    v.setInt16(i * 4 + 2, 0, true); // right channel silent
  }
  const a = new Analyzer(rate, 2);
  a.push(pcm);
  const f = a.frame(0.5);
  expect(f.l).toBeCloseTo(0.5, 1);
  expect(f.r).toBe(0);
  expect(f.rmsL).toBeCloseTo(0.354, 1);
  const bin = Math.round((1000 * 2048) / rate);
  const edges = bandEdges(rate);
  const band = edges.findIndex((e, i) => bin >= e && bin < edges[i + 1]!);
  const loudest = f.bands.indexOf(Math.max(...f.bands));
  expect(f.bands.length).toBe(BANDS);
  expect(Math.abs(loudest - band)).toBeLessThanOrEqual(1);
  expect(f.bands[2]!).toBeLessThan(0.3);
  expect(a.frame(0).l).toBe(0); // meters reset between frames
});
