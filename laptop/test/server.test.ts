import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import dgram from "node:dgram";
import type { Config } from "../src/config";
import type { Player, PlayerFactory } from "../src/player";
import { AudioServer } from "../src/server";

const config: Config = {
  code: "424242", sink: "", volume: 1, volumeScale: "cubic", muted: false, followPhone: true, name: "testbox",
  latency: "stable", notify: false, usb: false,
};

type FakePlayer = Player & { data: number[]; opts: Parameters<PlayerFactory>[0] };
let players: FakePlayer[] = [];
const factory: PlayerFactory = (opts) => {
  let closed = false;
  const p: FakePlayer = {
    data: [],
    opts,
    get closed() { return closed; },
    write(pcm) { p.data.push(...pcm); return "ok" as const; },
    leadMs: 0,
    underruns: 0,
    compressedMs: 0,
    targetMs: 100,
    setLatency() {},
    close() { closed = true; },
  };
  players.push(p);
  return p;
};

let server: AudioServer;
let changes = 0;
afterEach(() => {
  server?.close();
  players = [];
  changes = 0;
});

let controls: { volume?: number; muted?: boolean }[] = [];
async function start(cfg = config) {
  controls = [];
  server = new AudioServer(() => cfg, factory, {
    onChange: () => changes++, onLevel: () => {}, onControl: (c) => controls.push(c), addresses: () => ["10.0.0.5"],
  }, 500);
  return server.listen(0, "127.0.0.1");
}

function connect(port: number) {
  const sock = net.connect(port, "127.0.0.1");
  let buf = "";
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      w ? w(l) : lines.push(l);
    }
  });
  const closed = new Promise<void>((r) => sock.on("close", () => r()));
  return {
    sock,
    closed,
    line: () => new Promise<string>((r) => (lines.length ? r(lines.shift()!) : waiters.push(r))),
  };
}
const hello = (code: string) =>
  JSON.stringify({ v: 1, code, device: "Pixel", rate: 48000, channels: 2, format: "s16le" }) + "\n";
const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(5);
  }
};

test("accepts the right code and plays aligned PCM", async () => {
  const port = await start();
  const c = connect(port);
  // Hello and the first audio bytes arrive in one packet, with half a frame.
  c.sock.write(Buffer.concat([Buffer.from(hello("424242")), Buffer.from([1, 0, 2, 0, 3, 0])]));
  expect(JSON.parse(await c.line())).toEqual({ ok: true, name: "testbox" });
  await until(() => server.session !== null);
  expect(server.session).toMatchObject({ device: "Pixel", address: "127.0.0.1", rate: 48000 });
  c.sock.write(Buffer.from([4, 0]));
  await until(() => players[0]?.data.length === 8);
  expect(players[0]!.data).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
  expect(players[0]!.opts).toEqual({ rate: 48000, channels: 2, sink: "", latency: "stable", screenOff: false });
  c.sock.end();
  await until(() => server.session === null);
  expect(players[0]!.closed).toBe(true);
});

test("rejects a wrong code and rate limits", async () => {
  const port = await start();
  for (let i = 0; i < 5; i++) {
    const c = connect(port);
    c.sock.write(hello("000000"));
    expect(JSON.parse(await c.line())).toEqual({ ok: false, error: "bad_code" });
    await c.closed;
  }
  const c = connect(port);
  c.sock.write(hello("424242"));
  expect(JSON.parse(await c.line())).toEqual({ ok: false, error: "rate_limited" });
  expect(server.session).toBeNull();
});

test("a new phone replaces the old session", async () => {
  const port = await start();
  const a = connect(port);
  a.sock.write(hello("424242"));
  await a.line();
  const b = connect(port);
  b.sock.write(hello("424242"));
  await b.line();
  await a.closed;
  await until(() => server.session?.id === 2);
  b.sock.end();
});

test("drops silent clients after the hello timeout", async () => {
  const port = await start();
  const c = connect(port);
  await c.closed;
  expect(server.session).toBeNull();
});

test("oversized hello is dropped", async () => {
  const port = await start();
  const c = connect(port);
  c.sock.write("x".repeat(5000));
  await c.closed;
});

test("discovery answers broadcasts", async () => {
  await start();
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  // Use an ephemeral discovery port to avoid clashing with a running service.
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((r) => probe.bind(0, "127.0.0.1", () => r()));
  const discPort = probe.address().port;
  probe.close();
  await server.listenDiscovery(discPort, 47800);
  const reply = new Promise<string>((r) => sock.once("message", (m) => r(m.toString())));
  sock.send('{"dhvani":"discover","v":1}', discPort, "127.0.0.1");
  expect(JSON.parse(await reply)).toEqual({ dhvani: "here", v: 1, name: "testbox", port: 47800 });
  sock.close();
});

test("phone volume scales output; muted phone means silent laptop", async () => {
  const port = await start();
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((r) => probe.bind(0, "127.0.0.1", () => r()));
  const discPort = probe.address().port;
  probe.close();
  await server.listenDiscovery(discPort, port);
  const c = connect(port);
  c.sock.write(hello("424242"));
  await c.line();
  await until(() => server.session !== null);
  const udp = dgram.createSocket("udp4");
  const send = (o: object) => udp.send(JSON.stringify({ dhvani: "volume", v: 1, ...o }), discPort, "127.0.0.1");
  // Wrong code is ignored.
  send({ code: "000000", index: 0, max: 15, muted: true });
  send({ code: "424242", index: 15, max: 15, muted: true });
  await until(() => server.session?.phoneVolume?.muted === true);
  c.sock.write(Buffer.from([0x00, 0x40, 0x00, 0x40]));
  await until(() => players[0]?.data.length === 4);
  expect(players[0]!.data).toEqual([0, 0, 0, 0]);
  send({ code: "424242", index: 15, max: 15, muted: false });
  await until(() => server.session?.phoneVolume?.muted === false);
  c.sock.write(Buffer.from([0x00, 0x40, 0x00, 0x40]));
  await until(() => players[0]!.data.length === 8);
  expect(players[0]!.data.slice(4)).toEqual([0x00, 0x40, 0x00, 0x40]);
  udp.close();
  c.sock.end();
});

test("followPhone off ignores the phone's volume", async () => {
  const port = await start({ ...config, followPhone: false });
  const c = connect(port);
  c.sock.write(hello("424242"));
  await c.line();
  await until(() => server.session !== null);
  server.session!.phoneVolume = { index: 0, max: 15, muted: true };
  c.sock.write(Buffer.from([0x00, 0x40, 0x00, 0x40]));
  await until(() => players[0]?.data.length === 4);
  expect(players[0]!.data).toEqual([0x00, 0x40, 0x00, 0x40]);
  c.sock.end();
});

test("a missing output plays silence instead of falling back to the speakers", async () => {
  let missing = true;
  server = new AudioServer(() => config, factory, { onChange: () => {}, onLevel: () => {}, outputMissing: () => missing }, 500);
  const port = await server.listen(0, "127.0.0.1");
  const c = connect(port);
  c.sock.write(hello("424242"));
  await c.line();
  await until(() => server.session !== null);
  c.sock.write(Buffer.from([0x00, 0x40, 0x00, 0x40]));
  await until(() => players[0]?.data.length === 4);
  expect(players[0]!.data).toEqual([0, 0, 0, 0]);
  missing = false;
  c.sock.write(Buffer.from([0x00, 0x40, 0x00, 0x40]));
  await until(() => players[0]?.data.length === 8);
  expect(players[0]!.data.slice(4)).toEqual([0x00, 0x40, 0x00, 0x40]);
  c.sock.end();
});

test("laptop pushes its volume to the phone after the reply", async () => {
  const port = await start({ ...config, volume: 0.8, muted: true });
  const c = connect(port);
  c.sock.write(hello("424242"));
  expect(JSON.parse(await c.line()).ok).toBe(true);
  expect(JSON.parse(await c.line())).toEqual({ dhvani: "laptop", volume: 0.8, muted: true, addresses: ["10.0.0.5"] });
  c.sock.end();
});

test("discover request over TCP gets a reply and no session (USB probe)", async () => {
  const port = await start();
  const c = connect(port);
  c.sock.write(JSON.stringify({ dhvani: "discover", v: 1 }) + "\n");
  expect(JSON.parse(await c.line())).toEqual({ dhvani: "here", v: 1, name: "testbox", port });
  await c.closed;
  expect(server.session).toBeNull();
});

test("control packet from the streaming phone reaches the hook; wrong code does not", async () => {
  const port = await start();
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((r) => probe.bind(0, "127.0.0.1", () => r()));
  const discPort = probe.address().port;
  probe.close();
  await server.listenDiscovery(discPort, port);
  const c = connect(port);
  c.sock.write(hello("424242"));
  await c.line();
  await until(() => server.session !== null);
  const udp = dgram.createSocket("udp4");
  const send = (o: object) => udp.send(JSON.stringify({ dhvani: "control", v: 1, ...o }), discPort, "127.0.0.1");
  send({ code: "111111", muted: true });
  send({ code: "424242", volume: 0.5, muted: true });
  await until(() => controls.length === 1);
  expect(controls[0]).toEqual({ volume: 0.5, muted: true });
  udp.close();
  c.sock.end();
});

import { encodeAudioPacket, TCP_FALLBACK_LINE, UDP_RESUME_LINE } from "../src/protocol";

async function startUdp(retryMs?: number) {
  controls = [];
  server = new AudioServer(() => config, factory, {
    onChange: () => changes++, onLevel: () => {}, addresses: () => [], allowUdp: () => true,
  }, 500, retryMs);
  const port = await server.listen(0, "127.0.0.1");
  await server.listenDiscovery(0, port);
  return port;
}
const helloUdp = JSON.stringify({ v: 1, code: "424242", device: "Pixel", rate: 48000, channels: 2, format: "s16le", udp: 1 }) + "\n";

test("UDP audio: offered on hello, reordered, late copy fills a loss", async () => {
  const port = await startUdp();
  const c = connect(port);
  c.sock.write(helloUdp);
  const reply = JSON.parse(await c.line());
  expect(reply.ok).toBe(true);
  expect(reply.udp.token).toMatch(/^[0-9a-f]{16}$/);
  expect(server.session?.transport).toBe("udp");
  const token = Buffer.from(reply.udp.token, "hex");
  const udp = dgram.createSocket("udp4");
  const send = (seq: number, v: number, late = false, tok: Uint8Array = token) =>
    udp.send(encodeAudioPacket({ token: tok, seq, sentMs: 1000 + seq * 5, late, pcm: new Uint8Array(4).fill(v) }), reply.udp.port, "127.0.0.1");
  send(0, 1);
  send(2, 3);
  send(5, 9, false, Buffer.alloc(8)); // wrong token: ignored
  await Bun.sleep(5);
  send(1, 2, true);
  await until(() => players[0]?.data.length === 12);
  expect(players[0]!.data).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  // TCP bytes are not audio while UDP carries it.
  c.sock.write(Buffer.from([7, 7, 7, 7]));
  await Bun.sleep(30);
  expect(players[0]!.data.length).toBe(12);
  udp.close();
  c.sock.end();
});

test("UDP that never arrives falls back to TCP audio", async () => {
  const port = await startUdp();
  const c = connect(port);
  c.sock.write(helloUdp);
  expect(JSON.parse(await c.line()).udp).toBeDefined();
  let l = "";
  while ((l = await c.line()) !== TCP_FALLBACK_LINE.trim()) {}
  expect(server.session?.transport).toBe("tcp");
  c.sock.write(Buffer.from([5, 0, 6, 0]));
  await until(() => players[0]?.data.length === 4);
  c.sock.end();
}, 6000);

test("after a TCP fallback, UDP comes back once the phone's reports get through", async () => {
  const port = await startUdp(0);
  const c = connect(port);
  c.sock.write(helloUdp);
  const reply = JSON.parse(await c.line());
  const token = Buffer.from(reply.udp.token, "hex");
  while ((await c.line()) !== TCP_FALLBACK_LINE.trim()) {}
  c.sock.write(Buffer.from([5, 0, 6, 0]));
  await until(() => players[0]?.data.length === 4);
  const udp = dgram.createSocket("udp4");
  // A phone report over UDP: the path works now, so the laptop asks for UDP audio again.
  udp.send(JSON.stringify({ dhvani: "stats", v: 1, code: "424242", rssi: -60 }), reply.udp.port, "127.0.0.1");
  while ((await c.line()) !== UDP_RESUME_LINE.trim()) {}
  // TCP audio still plays until the first UDP packet lands.
  c.sock.write(Buffer.from([7, 0, 7, 0]));
  await until(() => players[0]?.data.length === 8);
  // The phone's sequence moved on while it sent over TCP; that is not a hole to fill.
  udp.send(encodeAudioPacket({ token, seq: 4000, sentMs: 50_000, late: false, pcm: new Uint8Array(4).fill(9) }), reply.udp.port, "127.0.0.1");
  await until(() => server.session?.transport === "udp");
  await until(() => players[0]?.data.length === 12);
  expect(players[0]!.data.slice(8)).toEqual([9, 9, 9, 9]);
  c.sock.write(Buffer.from([1, 1, 1, 1]));
  await Bun.sleep(30);
  expect(players[0]!.data.length).toBe(12);
  udp.close();
  c.sock.end();
}, 8000);

test("a UDP retry that gets nothing goes back to TCP", async () => {
  const port = await startUdp(0);
  const c = connect(port);
  c.sock.write(helloUdp);
  const reply = JSON.parse(await c.line());
  while ((await c.line()) !== TCP_FALLBACK_LINE.trim()) {}
  const udp = dgram.createSocket("udp4");
  udp.send(JSON.stringify({ dhvani: "stats", v: 1, code: "424242" }), reply.udp.port, "127.0.0.1");
  while ((await c.line()) !== UDP_RESUME_LINE.trim()) {}
  while ((await c.line()) !== TCP_FALLBACK_LINE.trim()) {}
  expect(server.session?.transport).toBe("tcp");
  expect(server.session).not.toBeNull();
  udp.close();
  c.sock.end();
}, 10000);
