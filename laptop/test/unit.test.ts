import { describe, expect, test } from "bun:test";
import { FrameAligner, JitterBuffer, Limiter, fromLinearVolume, latencyBounds, processPcm, volumeGain } from "../src/audio";
import { Accelerator } from "../src/stretch";
import { SessionNotifier } from "../src/notify";
import { BACK_STABLE_MS, PinnedOutput } from "../src/output";
import { sessionHistory } from "../src/report";
import { usbSerials } from "../src/usb";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitize, defaults, loadConfig } from "../src/config";
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
  test("gain above unity limits peaks instead of clipping", () => {
    const { out, peak } = processPcm(pcm(1000, -20000), 1.5);
    expect(read(out)).toEqual([1500, -30000]);
    const loud = read(processPcm(pcm(30000, -30000), 1.5).out);
    expect(Math.max(...loud.map(Math.abs))).toBeLessThanOrEqual(31130);
    expect(loud.every((s) => Math.abs(s) > 31000)).toBe(true);
    expect(peak).toBeCloseTo(30000 / 32768);
    expect(read(processPcm(pcm(1000, -1000), 0).out)).toEqual([0, 0]);
  });
  test("limiter recovers gain after a peak", () => {
    const l = new Limiter(1, 48000);
    l.process(pcm(32000), 1.5);
    const quiet = pcm(...Array(48000).fill(1000));
    const after = read(l.process(quiet, 1.5).out);
    expect(after[0]).toBeLessThan(1000);
    expect(after[after.length - 1]).toBe(1500);
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

test("volume curve is cubic: 0 silent, 100% unity, 50% about -18 dB, 150% about +10.6 dB", () => {
  expect(volumeGain(0)).toBe(0);
  expect(volumeGain(1)).toBe(1);
  expect(20 * Math.log10(volumeGain(0.5))).toBeCloseTo(-18.06, 1);
  expect(20 * Math.log10(volumeGain(1.5))).toBeCloseTo(10.57, 1);
  // Each 5% step near the bottom no longer jumps several dB more than one near the top.
  const db = (v: number) => 20 * Math.log10(volumeGain(v));
  expect(db(0.3) - db(0.25)).toBeLessThan(5);
  expect(db(1.5) - db(1.45)).toBeGreaterThan(0.8);
});

test("a config saved on the old linear scale keeps its loudness", () => {
  const dir = mkdtempSync(join(tmpdir(), "dhvani-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...defaults(), volumeScale: undefined, volume: 0.13 }));
  const c = loadConfig(path);
  expect(c.volume).toBe(0.51);
  expect(volumeGain(c.volume)).toBeCloseTo(0.13, 2);
  expect(JSON.parse(readFileSync(path, "utf8")).volumeScale).toBe("cubic");
  // Loading again must not convert twice.
  expect(loadConfig(path).volume).toBe(0.51);
  expect(fromLinearVolume(1.5)).toBe(1.14);
  expect(fromLinearVolume(1)).toBe(1);
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
  expect(b.admit(10)).toEqual({ play: true, prefillMs: 100, mode: "play" });
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
  t += 400; // dry for ~290 ms after audible audio: grows by the dry spell, capped at 60
  expect(b.admit(10).prefillMs).toBe(160);
  expect(b.underruns).toBe(1);
  b.admit(10, true);
  t += 2000; // phone paused sending during silence
  b.admit(10);
  expect(b.underruns).toBe(1);
  expect(b.targetMs).toBe(160);
  for (let i = 0; i < 3100; i++) { t += 10; b.admit(10); }
  expect(b.targetMs).toBe(150);
  t += 220; // shallow dry spell (~40-50 ms): grows by about that much
  b.admit(10);
  expect(b.underruns).toBe(2);
  expect(b.targetMs).toBeGreaterThanOrEqual(180);
  expect(b.targetMs).toBeLessThanOrEqual(210);
});

test("JitterBuffer drops quiet excess, compresses audible excess, caps bursts", () => {
  let t = 0;
  const b = new JitterBuffer(1, { minMs: 100, maxMs: 300 }, () => t);
  b.admit(10); // lead 110
  for (let i = 0; i < 3; i++) b.admit(10); // burst: lead 140
  expect(b.admit(10, true).mode).toBe("quiet"); // quiet and above target + 30: dropped
  expect(b.admit(10, false).mode).toBe("compress"); // audible: kept, played faster
  b.wrote(60); // the burst piles on: lead 200, then 210 ...
  const r = Array.from({ length: 20 }, () => {
    const a = b.admit(10, false);
    if (a.mode === "compress") b.wrote(10);
    return a.mode;
  });
  expect(r.filter((m) => m === "compress").length).toBe(11); // up to target + 200
  expect(r.at(-1)).toBe("late");
});

test("StreamStats does not count battery-saver idle as network gaps", () => {
  let t = 0;
  const s = new StreamStats(() => t);
  for (let i = 0; i < 50; i++) { t += 10; s.arrival(1920); s.chunk(0.5, 20); }
  s.arrival(1920); s.chunk(0, 20, true);
  for (let i = 0; i < 8; i++) { t += 250; s.arrival(1920); s.chunk(0, 20, true); } // keepalives
  const w = s.flush(192_000);
  expect(w.gapMaxMs).toBe(10);
  expect(w.gaps100).toBe(0);
  expect(w.idlePct).toBeGreaterThan(75);
  expect(w.ratePct).toBe(100);
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

import { Reorder, HOLE_WAIT_MS, MAX_CONCEAL, StaleGate, type Delivered } from "../src/udp";
import { declick } from "../src/audio";
import { encodeAudioPacket, parseAudioPacket, isAudioPacket } from "../src/protocol";
import { spread } from "../src/stats";
import { parseOutputDelay } from "../src/player";

describe("UDP audio", () => {
  const pcm = (v: number) => new Uint8Array(4).fill(v);
  const setup = () => {
    let t = 0;
    const out: Delivered[] = [];
    const r = new Reorder((d) => out.push(d), () => t);
    return { r, out, vals: () => out.map((d) => d.pcm[0]), advance: (ms: number) => { t += ms; r.tick(); } };
  };

  test("packet header round-trips", () => {
    const token = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = encodeAudioPacket({ token, seq: 2 ** 32 - 1, sentMs: 123456, late: true, pcm: pcm(9) });
    expect(isAudioPacket(b)).toBe(true);
    expect(isAudioPacket(new TextEncoder().encode('{"dhvani":"stats"}'))).toBe(false);
    const p = parseAudioPacket(b)!;
    expect([...p.token]).toEqual([...token]);
    expect(p).toMatchObject({ seq: 2 ** 32 - 1, sentMs: 123456, late: true });
    expect([...p.pcm]).toEqual([9, 9, 9, 9]);
  });

  test("reorders, ignores duplicates and uses a late copy for a lost packet", () => {
    const { r, out, vals } = setup();
    r.push(10, 0, false, pcm(10));
    r.push(12, 0, false, pcm(12));
    r.push(10, 0, true, pcm(10)); // copy of one that arrived: ignored
    expect(vals()).toEqual([10]);
    r.push(11, 0, true, pcm(11)); // first copy of 11 was lost
    expect(vals()).toEqual([10, 11, 12]);
    expect(out[1]!.recovered).toBe(true);
    expect(r.recovered).toBe(1);
    expect(r.lost).toBe(0);
  });

  test("a packet lost twice is concealed once its copy is overdue", () => {
    const { r, out, vals, advance } = setup();
    r.push(0, 0, false, pcm(1));
    r.push(2, 0, false, pcm(3));
    advance(HOLE_WAIT_MS - 1);
    expect(vals()).toEqual([1]);
    advance(2);
    expect(out.length).toBe(3);
    expect(out[1]!.concealed).toBe(true);
    expect(r.lost).toBe(1);
    r.push(1, 0, true, pcm(2)); // too late now
    expect(out.length).toBe(3);
  });

  // Stereo s16 frames, one value per frame on both channels.
  const frames = (vals: number[]) => {
    const b = new Uint8Array(vals.length * 4);
    const v = new DataView(b.buffer);
    vals.forEach((x, i) => { v.setInt16(i * 4, x, true); v.setInt16(i * 4 + 2, x, true); });
    return b;
  };
  const left = (b: Uint8Array) => {
    const v = new DataView(b.buffer, b.byteOffset, b.length);
    return Array.from({ length: b.length / 4 }, (_, i) => v.getInt16(i * 4, true));
  };

  test("concealment fades out from where the audio stopped, and the next packet fades in", () => {
    let t = 0;
    const out: Delivered[] = [];
    const r = new Reorder((d) => out.push(d), () => t);
    r.push(0, 0, false, frames([100, 200, 300, 400]));
    r.push(2, 0, false, frames([1000, 1000, 1000, 1000]));
    t += HOLE_WAIT_MS + 1;
    r.tick();
    // Backwards from 400, down to silence: no jump at the start of the hole.
    expect(left(out[1]!.pcm)).toEqual([300, 150, 50, 0]);
    expect(left(out[2]!.pcm)[0]).toBe(0);
    expect(left(out[2]!.pcm)[3]).toBe(750);
  });

  test("a long hole is not filled with seconds of silence", () => {
    let t = 0;
    const out: Delivered[] = [];
    const r = new Reorder((d) => out.push(d), () => t);
    r.push(0, 0, false, pcm(1));
    r.push(500, 0, false, pcm(2));
    t += HOLE_WAIT_MS + 1;
    r.tick();
    expect(out.length).toBe(1 + MAX_CONCEAL + 1);
    expect(r.lost).toBe(499);
  });

  test("reset forgets the sequence so a new run does not count as a giant hole", () => {
    const { r, out } = setup();
    r.push(0, 0, false, pcm(1));
    r.reset();
    r.push(900, 0, false, pcm(2));
    expect(out.length).toBe(2);
    expect(r.lost).toBe(0);
  });

  test("declick ramps from the last sample written into the new audio", () => {
    const b = frames([1000, 1000, 1000, 1000]);
    declick(b, [0, 0], 2, 4);
    expect(left(b)).toEqual([0, 250, 500, 750]);
  });

  test("stale gate drops a stall's backlog but keeps live audio", () => {
    const g = new StaleGate();
    // Normal flow: transit 30 ms, phone clock offset arbitrary.
    let now = 1_000;
    for (let i = 0; i < 50; i++, now += 5) expect(g.stale(now - 30 - 5_000_000, now, 250)).toBe(false);
    // A 2 s stall, then the backlog arrives at once: old packets are stale, the newest are not.
    now += 2000;
    expect(g.stale(now - 2000 - 30 - 5_000_000, now, 250)).toBe(true);
    expect(g.stale(now - 1000 - 30 - 5_000_000, now, 250)).toBe(true);
    expect(g.stale(now - 100 - 30 - 5_000_000, now, 250)).toBe(false);
    expect(g.dropped).toBe(2);
  });

  test("stale gate follows a phone clock jump instead of dropping forever", () => {
    const g = new StaleGate();
    let now = 0;
    for (let i = 0; i < 10; i++, now += 5) g.stale(now - 30, now, 250);
    // The phone clock fell 5 s behind (deep sleep): every packet looks late at first.
    let dropped = 0;
    for (let i = 0; i < 400; i++, now += 5) if (g.stale(now - 5030, now, 250)) dropped++;
    expect(dropped).toBeGreaterThan(150);
    expect(dropped).toBeLessThan(250);
    expect(g.stale(now - 5030, now, 250)).toBe(false);
  });

  test("stale gate survives the phone clock wrapping", () => {
    const g = new StaleGate();
    const w = 2 ** 32;
    expect(g.stale(w - 10, 1000, 250)).toBe(false);
    expect(g.stale(5, 1015, 250)).toBe(false);
    expect(g.stale(w - 1000, 1020, 250)).toBe(true);
  });

  test("network jitter spread survives the phone clock wrapping", () => {
    const w = 2 ** 32;
    // arrival - sent: phone clock wrapped between samples 2 and 3.
    expect(spread([100 - (w - 10), 105 - (w - 5), 112 - 2, 120 - 9])).toEqual([0, 0, 0, 1]);
  });
});

test("output delay reads the sink's latency behind Dhvani's node", () => {
  const dump = [
    { id: 89, type: "PipeWire:Interface:Node", info: { props: { "node.name": "dhvani" } } },
    { id: 7, type: "PipeWire:Interface:Link", info: { "output-node-id": 89, "input-node-id": 101 } },
    { id: 101, type: "PipeWire:Interface:Node", info: {
      props: { "node.name": "bluez_output.41_42.1", "node.description": "Wireless" },
      params: { Latency: [{ direction: "Input", minNs: 134520833 }] },
    } },
  ];
  expect(parseOutputDelay(dump, 10)).toEqual({ ms: 145, device: "Wireless", bluetooth: true });
  expect(parseOutputDelay(dump.slice(1), 10)).toBeNull();
});

describe("Accelerator", () => {
  const RATE = 48000;
  const tone = (ms: number, hz: number, amp = 12000, ch = 2) => {
    const frames = (ms * RATE) / 1000;
    const b = new Uint8Array(frames * ch * 2);
    const v = new DataView(b.buffer);
    for (let f = 0; f < frames; f++)
      for (let c = 0; c < ch; c++) v.setInt16((f * ch + c) * 2, Math.round(amp * Math.sin((2 * Math.PI * hz * f) / RATE)), true);
    return b;
  };
  test("holds audio until a block is full, then shortens it", () => {
    const a = new Accelerator(2, RATE);
    for (let i = 0; i < 7; i++) expect(a.push(tone(5, 440)).length).toBe(0);
    const out = a.push(tone(5, 440));
    const block = 40 * 48 * 4;
    expect(out.length).toBeLessThan(block);
    expect(out.length).toBeGreaterThanOrEqual(block - 10 * 48 * 4);
    expect(a.removedMs).toBeGreaterThanOrEqual(2.5);
  });
  test("a cut in a tone lands on whole periods, so the splice is smooth", () => {
    const a = new Accelerator(1, RATE);
    const out = a.shorten(tone(40, 400, 12000, 1)); // period 120 frames
    const cut = 1920 - out.length / 2;
    expect(cut % 120).toBe(0);
    const v = new DataView(out.buffer);
    let jump = 0;
    for (let i = 1; i < out.length / 2; i++) jump = Math.max(jump, Math.abs(v.getInt16(i * 2, true) - v.getInt16((i - 1) * 2, true)));
    expect(jump).toBeLessThan(700); // a 400 Hz sine at 12000 moves at most ~630 per sample
  });
  test("noise with no good match plays unchanged", () => {
    const a = new Accelerator(1, RATE);
    const b = new Uint8Array(960 * 2);
    const v = new DataView(b.buffer);
    let x = 1;
    for (let i = 0; i < 960; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; v.setInt16(i * 2, (x % 20000) - 10000, true); }
    expect(a.shorten(b).length).toBe(b.length);
  });
  test("flush returns held audio untouched", () => {
    const a = new Accelerator(2, RATE);
    const t = tone(5, 440);
    a.push(t);
    expect(Array.from(a.flush())).toEqual(Array.from(t));
    expect(a.flush().length).toBe(0);
  });
});

test("JitterBuffer tops up a raised target in quiet chunks only", () => {
  let t = 0;
  const b = new JitterBuffer(1, { minMs: 50, maxMs: 120 }, () => t);
  b.admit(10); // lead 60
  b.setBounds(latencyBounds("low", true)); // floor 80
  expect(b.targetMs).toBe(80);
  t += 25; // lead 35, more than 30 short of target
  expect(b.admit(10, false).prefillMs).toBe(0); // audible: never padded
  t += 10; // lead 35
  const q = b.admit(10, true);
  expect(q.prefillMs).toBe(45);
  expect(b.lead()).toBe(90);
});

test("latencyBounds raises only the low floor when the phone screen is off", () => {
  expect(latencyBounds("low", false)).toEqual({ minMs: 50, maxMs: 200 });
  expect(latencyBounds("low", true)).toEqual({ minMs: 80, maxMs: 200 });
  expect(latencyBounds("stable", true)).toEqual({ minMs: 100, maxMs: 300 });
});

test("StreamStats counts packets held for seconds as stale, not jitter", () => {
  let t = 0;
  const s = new StreamStats(() => t);
  for (let i = 0; i < 40; i++) s.transit(i * 5, i * 5 + 3);
  s.transit(200, 5200); // held 5 s by a Wi-Fi outage
  const w = s.flush(192000);
  expect(w.stale).toBe(1);
  expect(w.netJitterMaxMs).toBe(0);
});

describe("PinnedOutput", () => {
  const wireless = { name: "bluez_output.W", description: "Wireless" };
  const rockerz = { name: "bluez_output.R", description: "ROCKERZ 430" };
  const speakers = { name: "alsa_output.pci.analog-stereo", description: "Speakers" };

  test("gone with the speakers as system output: silent", () => {
    const p = new PinnedOutput();
    expect(p.update(wireless.name, [speakers], speakers.name, 0)).toBe(true);
    expect(p.state).toEqual({ kind: "silent" });
  });

  test("gone while another Bluetooth device is the system output: play there", () => {
    const p = new PinnedOutput();
    expect(p.update(wireless.name, [speakers, rockerz], rockerz.name, 0)).toBe(true);
    expect(p.state).toEqual({ kind: "fallback", sink: rockerz.name, device: "ROCKERZ 430" });
  });

  test("back only after it stays back, so Bluetooth reconnect flapping does not flip it", () => {
    const p = new PinnedOutput();
    p.update(wireless.name, [speakers], speakers.name, 0);
    expect(p.update(wireless.name, [speakers, wireless], wireless.name, 2000)).toBe(false);
    expect(p.update(wireless.name, [speakers], speakers.name, 4000)).toBe(false); // flapped away again
    expect(p.update(wireless.name, [speakers, wireless], wireless.name, 6000)).toBe(false);
    expect(p.update(wireless.name, [speakers, wireless], wireless.name, 6000 + BACK_STABLE_MS)).toBe(true);
    expect(p.state).toEqual({ kind: "ok" });
  });

  test("a new session uses a returned output at once; pactl failing changes nothing", () => {
    const p = new PinnedOutput();
    p.update(wireless.name, [speakers], speakers.name, 0);
    expect(p.update(wireless.name, [], "", 1000)).toBe(false);
    expect(p.state.kind).toBe("silent");
    p.sessionStarted();
    expect(p.update(wireless.name, [wireless], wireless.name, 2000)).toBe(true);
    expect(p.state.kind).toBe("ok");
  });

  test("present or none pinned: ok, no change", () => {
    const p = new PinnedOutput();
    expect(p.update(wireless.name, [wireless], wireless.name, 0)).toBe(false);
    expect(p.update("", [], "", 0)).toBe(false);
  });
});

test("report: phone retries count per session, not the phone's running total", () => {
  const dir = mkdtempSync(join(tmpdir(), "dhvani-report-"));
  const file = join(dir, "events.jsonl");
  const t = (s: number) => new Date(Date.now() - 3600_000 + s * 1000).toISOString();
  const ev = [
    { t: t(0), ev: "start" },
    { t: t(1), ev: "session_start", session: 1, device: "Pixel" },
    { t: t(11), ev: "phone_stats", session: 1, reconnects: 0, stalls: 0 },
    { t: t(20), ev: "session_end", session: 1, reason: "timeout", durationS: 19 },
    // Laptop asleep: the phone kept retrying.
    { t: t(30), ev: "session_start", session: 2, device: "Pixel" },
    { t: t(40), ev: "phone_stats", session: 2, reconnects: 4143, stalls: 1 },
    { t: t(50), ev: "session_end", session: 2, reason: "phone_closed", durationS: 20 },
    { t: t(60), ev: "session_start", session: 3, device: "Pixel" },
    { t: t(70), ev: "phone_stats", session: 3, reconnects: 4144, stalls: 1 },
    { t: t(80), ev: "session_end", session: 3, reason: "phone_closed", durationS: 20 },
    // Start tapped again: totals restart.
    { t: t(90), ev: "session_start", session: 4, device: "Pixel" },
    { t: t(100), ev: "phone_stats", session: 4, reconnects: 2, stalls: 0 },
    { t: t(110), ev: "session_end", session: 4, reason: "phone_closed", durationS: 20 },
  ];
  writeFileSync(file, ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  expect(sessionHistory(file, 1).map((r) => r.reconnects)).toEqual([2, 1, 4143, 0]);
});

import { EventEmitter } from "node:events";
import { STUCK_MS, pipePlayer } from "../src/player";

describe("pipePlayer", () => {
  const fakeChild = () => {
    const kills: string[] = [];
    const stdin = Object.assign(new EventEmitter(), { writableLength: 0, write: () => true, end: () => {} });
    const child = Object.assign(new EventEmitter(), {
      stdin, stderr: new EventEmitter(), kills,
      kill: (sig: string) => (kills.push(sig), true),
    });
    return child;
  };
  const opts = { rate: 48000, channels: 2, sink: "" };

  test("a pw-cat that stops reading is killed so a new one can start", () => {
    const child = fakeChild();
    let t = 0;
    const exits: string[] = [];
    const p = pipePlayer(child as never, opts, (r) => exits.push(r), () => t);
    child.stdin.writableLength = 1e9;
    expect(p.write(new Uint8Array(192))).toBe("stalled");
    t = STUCK_MS - 1;
    expect(p.write(new Uint8Array(192))).toBe("stalled");
    expect(p.closed).toBe(false);
    t = STUCK_MS + 1;
    expect(p.write(new Uint8Array(192))).toBe("closed");
    expect(p.closed).toBe(true);
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(exits).toEqual(["pw-cat stopped reading; restarting it"]);
  });

  test("a short stall that clears does not count toward the next one", () => {
    const child = fakeChild();
    let t = 0;
    const p = pipePlayer(child as never, opts, () => {}, () => t);
    child.stdin.writableLength = 1e9;
    p.write(new Uint8Array(192));
    child.stdin.writableLength = 0;
    t = STUCK_MS - 100;
    p.write(new Uint8Array(192));
    child.stdin.writableLength = 1e9;
    t = STUCK_MS + 100;
    expect(p.write(new Uint8Array(192))).toBe("stalled");
    expect(p.closed).toBe(false);
  });

  test("a broken pipe kills pw-cat", () => {
    const child = fakeChild();
    pipePlayer(child as never, opts, () => {}, () => 0);
    child.stdin.emit("error", new Error("EPIPE"));
    expect(child.kills).toEqual(["SIGKILL"]);
  });
});
