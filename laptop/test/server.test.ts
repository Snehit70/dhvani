import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import dgram from "node:dgram";
import type { Config } from "../src/config";
import type { Player, PlayerFactory } from "../src/player";
import { AudioServer } from "../src/server";

const config: Config = { code: "424242", sink: "", volume: 1, muted: false, name: "testbox" };

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

async function start(cfg = config) {
  server = new AudioServer(() => cfg, factory, { onChange: () => changes++, onLevel: () => {} }, 500);
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
  expect(players[0]!.opts).toEqual({ rate: 48000, channels: 2, sink: "" });
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
