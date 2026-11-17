import net from "node:net";
import dgram from "node:dgram";
import type { Config } from "./config";
import { FrameAligner, processPcm } from "./audio";
import type { Player, PlayerFactory } from "./player";
import {
  FailureLimiter,
  MAX_HELLO_BYTES,
  codesMatch,
  discoverReply,
  encodeReply,
  isDiscoverRequest,
  parseHello,
  type Hello,
} from "./protocol";

export type Session = {
  id: number;
  device: string;
  address: string;
  since: number;
  rate: number;
  channels: number;
};

export type ServerHooks = {
  /** Session started, ended, or an error worth showing changed. */
  onChange(): void;
  /** Peak level 0..1, at most ~15 times a second. */
  onLevel(peak: number): void;
};

const LEVEL_INTERVAL_MS = 66;
const RESPAWN_INTERVAL_MS = 1000;

type Active = {
  session: Session;
  socket: net.Socket;
  hello: Hello;
  player: Player | null;
  lastSpawn: number;
};

export class AudioServer {
  session: Session | null = null;
  drops = 0;
  lastError = "";
  listening = false;
  discovery = false;

  private tcp: net.Server | null = null;
  private udp: dgram.Socket | null = null;
  private active: Active | null = null;
  private nextId = 1;
  private limiter = new FailureLimiter();
  private peak = 0;
  private lastLevelAt = 0;

  constructor(
    private getConfig: () => Config,
    private makePlayer: PlayerFactory,
    private hooks: ServerHooks,
    private helloTimeoutMs = 5000,
  ) {}

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    this.tcp = net.createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      this.tcp!.once("error", reject);
      this.tcp!.listen(port, host, () => resolve());
    });
    this.tcp.on("error", (e) => this.fail(`Audio server error: ${e.message}`));
    this.listening = true;
    return (this.tcp.address() as net.AddressInfo).port;
  }

  async listenDiscovery(port: number, audioPort: number): Promise<void> {
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.udp = udp;
    udp.on("message", (msg, rinfo) => {
      if (msg.length > 512 || !isDiscoverRequest(msg.toString())) return;
      const reply = Buffer.from(discoverReply(this.getConfig().name, audioPort));
      udp.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(port, () => resolve());
    });
    udp.on("error", (e) => this.fail(`Discovery error: ${e.message}`));
    this.discovery = true;
  }

  close(): void {
    this.disconnect();
    this.tcp?.close();
    this.udp?.close();
    this.listening = false;
    this.discovery = false;
  }

  /** Ends the current phone session, if any. */
  disconnect(): void {
    this.active?.socket.destroy();
    this.endActive();
  }

  /** Re-opens playback, e.g. after the output device changed. */
  restartPlayer(): void {
    if (!this.active) return;
    this.active.player?.close();
    this.active.player = null;
    this.active.lastSpawn = 0;
  }

  private fail(msg: string) {
    this.lastError = msg;
    this.hooks.onChange();
  }

  private accept(socket: net.Socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const address = (socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
    let buf = Buffer.alloc(0);
    let done = false;

    const timer = setTimeout(() => socket.destroy(), this.helloTimeoutMs);
    const reject = (error: Parameters<typeof encodeReply>[0]) => {
      done = true;
      clearTimeout(timer);
      socket.end(encodeReply(error));
    };

    const onHelloData = (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_HELLO_BYTES) {
          done = true;
          clearTimeout(timer);
          socket.destroy();
        }
        return;
      }
      if (nl > MAX_HELLO_BYTES) {
        done = true;
        clearTimeout(timer);
        socket.destroy();
        return;
      }
      const line = buf.subarray(0, nl).toString("utf8");
      const rest = buf.subarray(nl + 1);
      if (this.limiter.blocked(address)) return reject({ ok: false, error: "rate_limited" });
      const hello = parseHello(line);
      if ("error" in hello) return reject({ ok: false, error: hello.error });
      if (!codesMatch(hello.code, this.getConfig().code)) {
        this.limiter.fail(address);
        return reject({ ok: false, error: "bad_code" });
      }
      this.limiter.succeed(address);
      done = true;
      clearTimeout(timer);
      socket.off("data", onHelloData);
      this.start(socket, hello, address, rest);
    };

    socket.on("data", onHelloData);
    socket.on("error", () => {});
    socket.on("close", () => clearTimeout(timer));
  }

  private start(socket: net.Socket, hello: Hello, address: string, rest: Buffer) {
    // Latest phone wins: a new session replaces the old one.
    if (this.active) {
      this.active.socket.destroy();
      this.endActive();
    }
    const session: Session = {
      id: this.nextId++,
      device: hello.device,
      address,
      since: Date.now(),
      rate: hello.rate,
      channels: hello.channels,
    };
    const active: Active = { session, socket, hello, player: null, lastSpawn: 0 };
    this.active = active;
    this.session = session;
    this.drops = 0;
    this.lastError = "";
    socket.write(encodeReply({ ok: true, name: this.getConfig().name }));

    const aligner = new FrameAligner(2 * hello.channels);
    const onAudio = (chunk: Uint8Array) => {
      if (this.active !== active) return;
      const frames = aligner.push(chunk);
      if (!frames.length) return;
      const player = this.ensurePlayer(active);
      const cfg = this.getConfig();
      const { out, peak } = processPcm(frames, cfg.muted ? 0 : cfg.volume);
      if (player && !player.write(out)) this.drops++;
      this.reportLevel(peak);
    };
    socket.on("data", onAudio);
    socket.on("close", () => {
      if (this.active === active) this.endActive();
    });
    this.hooks.onChange();
    if (rest.length) onAudio(rest);
  }

  private ensurePlayer(active: Active): Player | null {
    if (active.player && !active.player.closed) return active.player;
    const now = Date.now();
    if (now - active.lastSpawn < RESPAWN_INTERVAL_MS) return null;
    active.lastSpawn = now;
    active.player = this.makePlayer(
      { rate: active.hello.rate, channels: active.hello.channels, sink: this.getConfig().sink },
      (reason) => {
        if (this.active === active && active.player?.closed) this.fail(reason);
      },
    );
    return active.player;
  }

  private reportLevel(peak: number) {
    if (peak > this.peak) this.peak = peak;
    const now = Date.now();
    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;
      this.hooks.onLevel(this.peak);
      this.peak = 0;
    }
  }

  private endActive() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.session = null;
    a.player?.close();
    this.hooks.onLevel(0);
    this.hooks.onChange();
  }
}
