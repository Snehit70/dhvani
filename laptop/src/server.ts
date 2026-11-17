import net from "node:net";
import dgram from "node:dgram";
import type { Config } from "./config";
import { FrameAligner, processPcm } from "./audio";
import { log } from "./log";
import type { Player, PlayerFactory } from "./player";
import { StreamStats } from "./stats";
import {
  FailureLimiter,
  MAX_HELLO_BYTES,
  codesMatch,
  discoverReply,
  encodeReply,
  isDiscoverRequest,
  parseHello,
  parsePhoneStats,
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
export const STATS_INTERVAL_MS = 10_000;

export type SessionSummary = {
  device: string; start: number; durationS: number; reason: string; drops: number; underruns: number;
};

export type EndReason = "phone_closed" | "socket_error" | "replaced" | "disconnected" | "code_changed" | "shutdown";

type Active = {
  session: Session;
  socket: net.Socket;
  hello: Hello;
  player: Player | null;
  lastSpawn: number;
  stats: StreamStats;
  statsTimer: ReturnType<typeof setInterval>;
  totalBytes: number;
  totalDrops: number;
  /** Underruns from players that already exited, plus the live player's count. */
  pastUnderruns: number;
  reportedUnderruns: number;
  socketError: string;
};

export class AudioServer {
  session: Session | null = null;
  drops = 0;
  lastError = "";
  /** Latest 10 s stream window and phone report for the live session (null when idle). */
  quality: Record<string, unknown> | null = null;
  phone: Record<string, unknown> | null = null;
  /** Most recent sessions, newest first. */
  recent: SessionSummary[] = [];
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
      if (msg.length > 1024) return;
      const text = msg.toString();
      const stats = parsePhoneStats(text);
      if (stats) return this.phoneStats(stats, rinfo.address);
      if (msg.length > 512 || !isDiscoverRequest(text)) return;
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
    this.disconnect("shutdown");
    this.tcp?.close();
    this.udp?.close();
    this.listening = false;
    this.discovery = false;
  }

  /** Ends the current phone session, if any. */
  disconnect(reason: EndReason = "disconnected"): void {
    this.active?.socket.destroy();
    this.endActive(reason);
  }

  /** Re-opens playback, e.g. after the output device changed. */
  restartPlayer(): void {
    if (!this.active) return;
    this.retirePlayer(this.active);
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

    const timer = setTimeout(() => {
      log("hello_rejected", { address, error: "timeout" });
      socket.destroy();
    }, this.helloTimeoutMs);
    const reject = (error: Parameters<typeof encodeReply>[0]) => {
      done = true;
      clearTimeout(timer);
      if (!error.ok) log("hello_rejected", { address, error: error.error });
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
          log("hello_rejected", { address, error: "too_long" });
          socket.destroy();
        }
        return;
      }
      if (nl > MAX_HELLO_BYTES) {
        done = true;
        log("hello_rejected", { address, error: "too_long" });
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
      this.endActive("replaced");
    }
    const session: Session = {
      id: this.nextId++,
      device: hello.device,
      address,
      since: Date.now(),
      rate: hello.rate,
      channels: hello.channels,
    };
    const bytesPerSec = hello.rate * hello.channels * 2;
    const active: Active = {
      session, socket, hello, player: null, lastSpawn: 0,
      stats: new StreamStats(),
      statsTimer: setInterval(() => this.flushStats(active, bytesPerSec), STATS_INTERVAL_MS),
      totalBytes: 0, totalDrops: 0, pastUnderruns: 0, reportedUnderruns: 0, socketError: "",
    };
    active.statsTimer.unref?.();
    this.active = active;
    log("session_start", {
      session: session.id, device: session.device, address, rate: hello.rate, channels: hello.channels,
      sink: this.getConfig().sink || "default", volume: this.getConfig().volume, muted: this.getConfig().muted,
    });
    this.session = session;
    this.drops = 0;
    this.lastError = "";
    this.quality = null;
    this.phone = null;
    socket.write(encodeReply({ ok: true, name: this.getConfig().name }));

    const aligner = new FrameAligner(2 * hello.channels);
    const onAudio = (chunk: Uint8Array) => {
      if (this.active !== active) return;
      active.stats.arrival(chunk.length);
      active.totalBytes += chunk.length;
      const frames = aligner.push(chunk);
      if (!frames.length) return;
      const player = this.ensurePlayer(active);
      const cfg = this.getConfig();
      const { out, peak } = processPcm(frames, cfg.muted ? 0 : cfg.volume);
      const result = player ? player.write(out) : "closed";
      if (result !== "ok") {
        this.drops++;
        active.totalDrops++;
        if (result === "late") active.stats.dropLate++;
        else if (result === "stalled") active.stats.dropStalled++;
        else active.stats.dropNoPlayer++;
      }
      active.stats.chunk(peak, player?.leadMs ?? 0);
      this.reportLevel(peak);
    };
    socket.on("data", onAudio);
    socket.on("error", (e) => {
      active.socketError = e.message;
    });
    socket.on("close", () => {
      if (this.active === active) this.endActive(active.socketError ? "socket_error" : "phone_closed");
    });
    this.hooks.onChange();
    if (rest.length) onAudio(rest);
  }

  private ensurePlayer(active: Active): Player | null {
    if (active.player && !active.player.closed) return active.player;
    const now = Date.now();
    if (now - active.lastSpawn < RESPAWN_INTERVAL_MS) return null;
    active.lastSpawn = now;
    if (active.player) this.retirePlayer(active);
    const sink = this.getConfig().sink;
    log("player_start", { session: active.session.id, sink: sink || "default" });
    const player = this.makePlayer(
      { rate: active.hello.rate, channels: active.hello.channels, sink },
      (reason) => {
        log("player_exit", { session: active.session.id, reason });
        if (this.active === active && active.player === player) this.fail(reason);
      },
    );
    active.player = player;
    return player;
  }

  private retirePlayer(active: Active) {
    if (!active.player) return;
    active.pastUnderruns += active.player.underruns;
    active.player.close();
    active.player = null;
  }

  private underruns(active: Active) {
    return active.pastUnderruns + (active.player?.underruns ?? 0);
  }

  private flushStats(active: Active, bytesPerSec: number) {
    const u = this.underruns(active);
    const window = { ...active.stats.flush(bytesPerSec), underruns: u - active.reportedUnderruns };
    log("session_stats", { session: active.session.id, ...window });
    active.reportedUnderruns = u;
    if (this.active === active) {
      this.quality = window;
      this.hooks.onChange();
    }
  }

  private phoneStats(s: { code: string; fields: Record<string, unknown> }, address: string) {
    const a = this.active;
    // Only the phone that is currently streaming, with the right code, gets logged.
    if (!a || a.session.address !== address || !codesMatch(s.code, this.getConfig().code)) return;
    log("phone_stats", { session: a.session.id, ...s.fields });
    this.phone = s.fields;
    this.hooks.onChange();
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

  private endActive(reason: EndReason) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.session = null;
    clearInterval(a.statsTimer);
    this.flushStats(a, a.hello.rate * a.hello.channels * 2);
    this.quality = null;
    this.phone = null;
    const durationS = Math.round((Date.now() - a.session.since) / 100) / 10;
    this.recent = [
      { device: a.session.device, start: a.session.since, durationS, reason, drops: a.totalDrops, underruns: this.underruns(a) },
      ...this.recent,
    ].slice(0, 6);
    log("session_end", {
      session: a.session.id,
      reason,
      error: a.socketError || undefined,
      durationS,
      mb: Math.round(a.totalBytes / 1e4) / 100,
      drops: a.totalDrops,
      underruns: this.underruns(a),
    });
    this.retirePlayer(a);
    this.hooks.onLevel(0);
    this.hooks.onChange();
  }
}
