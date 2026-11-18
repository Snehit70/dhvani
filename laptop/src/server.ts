import net from "node:net";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import type { Config } from "./config";
import { FrameAligner, Limiter, QUIET_PEAK, type LatencyMode } from "./audio";
import { Analyzer, type LevelFrame } from "./analyzer";
import { log } from "./log";
import type { Player, PlayerFactory } from "./player";
import { StreamStats } from "./stats";
import { Reorder, type Delivered } from "./udp";
import {
  FailureLimiter,
  MAX_HELLO_BYTES,
  codesMatch,
  discoverReply,
  encodeReply,
  isDiscoverRequest,
  parseHello,
  parsePhoneStats,
  parseControl,
  parsePhoneVolume,
  laptopState,
  phoneGain,
  isAudioPacket,
  parseAudioPacket,
  PING_LINE,
  TCP_FALLBACK_LINE,
  type PhoneControl,
  type Hello,
} from "./protocol";

export type Session = {
  id: number;
  device: string;
  address: string;
  since: number;
  rate: number;
  channels: number;
  /** How the audio travels: UDP with late copies, or the TCP control socket itself. */
  transport: "udp" | "tcp";
  /** Phone media volume as last reported (null until the phone app sends it). */
  phoneVolume: { index: number; max: number; muted: boolean } | null;
};

export type ServerHooks = {
  /** Session started, ended, or an error worth showing changed. */
  onChange(): void;
  /** Meters and spectrum, at most ~15 times a second. */
  onLevel(frame: LevelFrame): void;
  /** One-second stream readings for the live charts. */
  onMetrics?(m: LiveMetrics): void;
  /** The streaming phone asked to change the laptop's volume or mute. */
  onControl?(c: { volume?: number; muted?: boolean }): void;
  onSessionStart?(s: Session): void;
  onSessionEnd?(s: Session, reason: EndReason): void;
  /** LAN addresses the phone can send UDP reports to when it streams over USB. */
  addresses?(): string[];
  /** Whether a phone at this address may stream over UDP. Default: anything but loopback (USB). */
  allowUdp?(address: string): boolean;
};

const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a.startsWith("127.");

const LEVEL_INTERVAL_MS = 66;
const RESPAWN_INTERVAL_MS = 1000;
/** No UDP audio this long after the session starts: the path is blocked, fall back to TCP. */
export const UDP_FALLBACK_MS = 2500;
/** UDP audio stopped this long (the phone sends a keepalive at least every 250 ms): phone is gone. */
export const UDP_TIMEOUT_MS = 5000;
export const STATS_INTERVAL_MS = 10_000;

export type SessionSummary = {
  device: string; start: number; durationS: number; reason: string; drops: number; underruns: number;
};

export type LiveMetrics = {
  t: number;
  /** Kilobits per second received from the phone. */
  kbps: number;
  /** Longest pause between arriving packets in this second. */
  gapMaxMs: number;
  /** Audio queued ahead of playback, and what the jitter buffer aims for. */
  leadMs: number;
  targetMs: number;
  /** Only silence arrived this second (the phone may be saving battery). */
  idle: boolean;
  /** Totals for the session so far. */
  drops: number;
  underruns: number;
  rssi: number | null;
  /** Spread of UDP packet travel times this second (null over TCP). */
  jitterMs: number | null;
  /** UDP packets saved by their late copy, and lost twice, session totals. */
  recovered: number;
  lost: number;
};

export type EndReason = "phone_closed" | "socket_error" | "timeout" | "replaced" | "disconnected" | "code_changed" | "shutdown";

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
  /** Same bookkeeping for audio shortened to shed delay, ms. */
  pastCompressedMs: number;
  reportedCompressedMs: number;
  /** The phone said its screen is off (Wi-Fi may doze), so the buffer floor is higher. */
  screenOff: boolean;
  socketError: string;
  analyzer: Analyzer;
  limiter: Limiter;
  sec: { bytes: number; gapMax: number; lastAt: number; lastSilent: boolean; idle: boolean; tMin: number; tMax: number };
  secTimer: ReturnType<typeof setInterval>;
  udp: {
    token: Buffer;
    reorder: Reorder;
    lastAt: number;
    timers: ReturnType<typeof setInterval>[];
  } | null;
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
  private audioPort = 0;
  private discoveryPort = 0;

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
    this.audioPort = (this.tcp.address() as net.AddressInfo).port;
    return this.audioPort;
  }

  async listenDiscovery(port: number, audioPort: number): Promise<void> {
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.udp = udp;
    udp.on("message", (msg, rinfo) => {
      if (isAudioPacket(msg)) return this.udpAudio(msg);
      if (msg.length > 1024) return;
      const text = msg.toString();
      const stats = parsePhoneStats(text);
      if (stats) return this.phoneStats(stats, rinfo.address);
      const vol = parsePhoneVolume(text);
      if (vol) return this.phoneVolume(vol, rinfo.address);
      const ctl = parseControl(text);
      if (ctl) return this.phoneControl(ctl, rinfo.address);
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
    this.discoveryPort = udp.address().port;
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

  /** Sends the laptop's volume and mute to the streaming phone. */
  pushLaptopState(): void {
    const a = this.active;
    if (!a || a.socket.destroyed) return;
    const cfg = this.getConfig();
    a.socket.write(laptopState(cfg.volume, cfg.muted, this.hooks.addresses?.() ?? []));
  }

  /** New bounds take effect at once; the player restarts so PipeWire's period follows the mode. */
  setLatency(mode: LatencyMode): void {
    this.active?.player?.setLatency(mode, this.active.screenOff);
    this.restartPlayer();
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
      if (isDiscoverRequest(line)) {
        // USB probe through adb reverse: answer like UDP discovery, no session, no log noise.
        done = true;
        clearTimeout(timer);
        socket.end(discoverReply(this.getConfig().name, this.audioPort) + "\n");
        return;
      }
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
      transport: "tcp",
      phoneVolume: null,
    };
    const allowUdp = this.hooks.allowUdp ? this.hooks.allowUdp(address) : !isLoopback(address);
    const useUdp = hello.udp && allowUdp && this.discovery;
    if (useUdp) session.transport = "udp";
    const bytesPerSec = hello.rate * hello.channels * 2;
    const active: Active = {
      session, socket, hello, player: null, lastSpawn: 0,
      stats: new StreamStats(),
      statsTimer: setInterval(() => this.flushStats(active, bytesPerSec), STATS_INTERVAL_MS),
      totalBytes: 0, totalDrops: 0, pastUnderruns: 0, reportedUnderruns: 0, pastCompressedMs: 0, reportedCompressedMs: 0, screenOff: false, socketError: "",
      analyzer: new Analyzer(hello.rate, hello.channels),
      limiter: new Limiter(hello.channels, hello.rate),
      sec: { bytes: 0, gapMax: 0, lastAt: 0, lastSilent: false, idle: true, tMin: Infinity, tMax: -Infinity },
      secTimer: setInterval(() => this.tickSecond(active), 1000),
      udp: null,
    };
    active.statsTimer.unref?.();
    active.secTimer.unref?.();
    this.active = active;
    log("session_start", {
      session: session.id, device: session.device, address, rate: hello.rate, channels: hello.channels,
      transport: session.transport,
      sink: this.getConfig().sink || "default", volume: this.getConfig().volume, muted: this.getConfig().muted,
    });
    this.session = session;
    this.drops = 0;
    this.lastError = "";
    this.quality = null;
    this.phone = null;
    const token = useUdp ? randomBytes(8) : null;
    socket.write(encodeReply({
      ok: true,
      name: this.getConfig().name,
      ...(token ? { udp: { port: this.discoveryPort, token: token.toString("hex") } } : {}),
    }));
    this.pushLaptopState();

    const aligner = new FrameAligner(2 * hello.channels);
    const onAudio = (chunk: Uint8Array, d?: Delivered) => {
      if (this.active !== active) return;
      const now = performance.now();
      if (d?.concealed) active.stats.lost++;
      else active.stats.arrival(chunk.length);
      if (d?.recovered) active.stats.recovered++;
      if (d && d.sentMs !== null && !d.recovered) {
        active.stats.transit(d.sentMs, now);
        const tr = now - d.sentMs;
        if (tr < active.sec.tMin) active.sec.tMin = tr;
        if (tr > active.sec.tMax) active.sec.tMax = tr;
      }
      active.totalBytes += chunk.length;
      if (active.sec.lastAt && !active.sec.lastSilent) active.sec.gapMax = Math.max(active.sec.gapMax, now - active.sec.lastAt);
      active.sec.lastAt = now;
      active.sec.bytes += chunk.length;
      const frames = aligner.push(chunk);
      if (!frames.length) return;
      active.analyzer.push(frames);
      const player = this.ensurePlayer(active);
      const cfg = this.getConfig();
      const pv = active.session.phoneVolume;
      const follow = cfg.followPhone && pv ? phoneGain(pv) : 1;
      const { out, peak } = active.limiter.process(frames, cfg.muted ? 0 : cfg.volume * follow);
      const result = player ? player.write(out, peak < QUIET_PEAK) : "closed";
      if (result === "quiet") active.stats.dropQuiet++;
      else if (result !== "ok") {
        this.drops++;
        active.totalDrops++;
        if (result === "late") active.stats.dropLate++;
        else if (result === "stalled") active.stats.dropStalled++;
        else active.stats.dropNoPlayer++;
      }
      // Post-gain peak is 0 when the laptop is muted; only then scan the raw frames.
      const silent = peak === 0 && isAllZero(frames);
      active.sec.lastSilent = silent;
      if (!silent) active.sec.idle = false;
      active.stats.chunk(peak, player?.leadMs ?? 0, silent);
      this.reportLevel(active, peak);
    };
    if (token) {
      const u: NonNullable<Active["udp"]> = {
        token,
        reorder: new Reorder((d) => onAudio(d.pcm, d)),
        lastAt: 0,
        timers: [],
      };
      active.udp = u;
      u.timers.push(
        setInterval(() => u.reorder.tick(), 5),
        setInterval(() => this.udpHousekeeping(active), 1000),
      );
      for (const t of u.timers) t.unref?.();
    }
    // Over UDP the socket carries no audio until the laptop asks for the TCP fallback.
    socket.on("data", (chunk: Uint8Array) => {
      if (active.session.transport === "tcp") onAudio(chunk);
    });
    socket.on("error", (e) => {
      active.socketError = e.message;
    });
    socket.on("close", () => {
      if (this.active === active) this.endActive(active.socketError ? "socket_error" : "phone_closed");
    });
    this.hooks.onChange();
    this.hooks.onSessionStart?.(session);
    if (rest.length && session.transport === "tcp") onAudio(rest);
  }

  private udpAudio(msg: Buffer) {
    const a = this.active;
    const u = a?.udp;
    if (!a || !u || a.session.transport !== "udp") return;
    const p = parseAudioPacket(msg);
    if (!p || !u.token.equals(p.token)) return;
    u.lastAt = performance.now();
    u.reorder.push(p.seq, p.sentMs, p.late, p.pcm);
  }

  /** Once a second over UDP: keep the phone's watchdog fed, fall back to TCP, notice a vanished phone. */
  private udpHousekeeping(active: Active) {
    const u = active.udp;
    if (this.active !== active || !u || active.socket.destroyed) return;
    if (active.session.transport !== "udp") return;
    const age = performance.now() - u.lastAt;
    if (!u.reorder.received && Date.now() - active.session.since >= UDP_FALLBACK_MS) {
      active.session.transport = "tcp";
      log("udp_fallback", { session: active.session.id });
      active.socket.write(TCP_FALLBACK_LINE);
      this.hooks.onChange();
      return;
    }
    if (u.reorder.received && age > UDP_TIMEOUT_MS) {
      log("udp_timeout", { session: active.session.id, ms: Math.round(age) });
      active.socket.destroy();
      this.endActive("timeout");
      return;
    }
    active.socket.write(PING_LINE);
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
      { rate: active.hello.rate, channels: active.hello.channels, sink, latency: this.getConfig().latency, screenOff: active.screenOff },
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
    active.pastCompressedMs += active.player.compressedMs;
    active.player.close();
    active.player = null;
  }

  private underruns(active: Active) {
    return active.pastUnderruns + (active.player?.underruns ?? 0);
  }

  private flushStats(active: Active, bytesPerSec: number) {
    const u = this.underruns(active);
    const c = active.pastCompressedMs + (active.player?.compressedMs ?? 0);
    const window = {
      ...active.stats.flush(bytesPerSec),
      underruns: u - active.reportedUnderruns,
      compressedMs: Math.round(c - active.reportedCompressedMs),
      targetMs: Math.round(active.player?.targetMs ?? 0),
    };
    log("session_stats", { session: active.session.id, ...window });
    active.reportedUnderruns = u;
    active.reportedCompressedMs = c;
    if (this.active === active) {
      this.quality = window;
      this.hooks.onChange();
    }
  }

  /**
   * The active session, if this UDP packet came from its phone. Over USB the session
   * address is loopback (adb reverse carries TCP only), so the phone reports over
   * Wi-Fi instead and only the code can tie the packet to the session.
   */
  private sessionFor(address: string, code: string): Active | null {
    const a = this.active;
    if (!a || !codesMatch(code, this.getConfig().code)) return null;
    if (a.session.address !== address && !isLoopback(a.session.address)) return null;
    return a;
  }

  private phoneStats(s: { code: string; fields: Record<string, unknown> }, address: string) {
    // Only the phone that is currently streaming, with the right code, gets logged.
    const a = this.sessionFor(address, s.code);
    if (!a) return;
    log("phone_stats", { session: a.session.id, ...s.fields });
    if (typeof s.fields.screenOn === "boolean" && a.screenOff === s.fields.screenOn) {
      a.screenOff = !s.fields.screenOn;
      log("phone_screen", { session: a.session.id, on: s.fields.screenOn });
      a.player?.setLatency(this.getConfig().latency, a.screenOff);
    }
    this.phone = s.fields;
    this.hooks.onChange();
  }

  private phoneVolume(v: { code: string; index: number; max: number; muted: boolean }, address: string) {
    const a = this.sessionFor(address, v.code);
    if (!a) return;
    const prev = a.session.phoneVolume;
    if (prev && prev.index === v.index && prev.max === v.max && prev.muted === v.muted) return;
    a.session.phoneVolume = { index: v.index, max: v.max, muted: v.muted };
    log("phone_volume", { session: a.session.id, index: v.index, max: v.max, muted: v.muted });
    this.hooks.onChange();
  }

  private phoneControl(c: PhoneControl, address: string) {
    const a = this.sessionFor(address, c.code);
    if (!a) return;
    const change: { volume?: number; muted?: boolean } = {};
    if (c.volume !== undefined) change.volume = c.volume;
    if (c.muted !== undefined) change.muted = c.muted;
    log("phone_control", { session: a.session.id, ...change });
    this.hooks.onControl?.(change);
  }

  private reportLevel(active: Active, peak: number) {
    if (peak > this.peak) this.peak = peak;
    const now = Date.now();
    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;
      this.hooks.onLevel(active.analyzer.frame(this.peak));
      this.peak = 0;
    }
  }

  private tickSecond(active: Active) {
    if (this.active !== active || !this.hooks.onMetrics) return;
    const s = active.sec;
    const rssi = this.phone?.rssi;
    this.hooks.onMetrics({
      t: Date.now(),
      kbps: Math.round((s.bytes * 8) / 1000),
      // Nothing arrived at all this second: the gap is still running.
      gapMaxMs: Math.round(s.bytes || s.lastSilent ? s.gapMax : performance.now() - s.lastAt),
      idle: s.idle,
      // Below zero only means nothing is queued (the phone idles during silence).
      leadMs: Math.max(0, Math.round(active.player?.leadMs ?? 0)),
      targetMs: Math.round(active.player?.targetMs ?? 0),
      drops: active.totalDrops,
      underruns: this.underruns(active),
      rssi: typeof rssi === "number" ? rssi : null,
      jitterMs: s.tMax >= s.tMin ? Math.round((s.tMax - s.tMin) * 10) / 10 : null,
      recovered: active.udp?.reorder.recovered ?? 0,
      lost: active.udp?.reorder.lost ?? 0,
    });
    s.bytes = 0;
    s.gapMax = 0;
    s.idle = true;
    s.tMin = Infinity;
    s.tMax = -Infinity;
  }

  private endActive(reason: EndReason) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.session = null;
    clearInterval(a.statsTimer);
    clearInterval(a.secTimer);
    for (const t of a.udp?.timers ?? []) clearInterval(t);
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
      transport: a.session.transport,
      recovered: a.udp?.reorder.recovered,
      lost: a.udp?.reorder.lost,
    });
    this.retirePlayer(a);
    this.hooks.onLevel({ peak: 0, l: 0, r: 0, rmsL: 0, rmsR: 0, bands: [] });
    this.hooks.onChange();
    this.hooks.onSessionEnd?.(a.session, reason);
  }
}

function isAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}
