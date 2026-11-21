import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { loadConfig, newCode, sanitize, saveConfig, type Config } from "./config";
import { LOG_FILE, log } from "./log";
import { recentSessions, report, sessionHistory } from "./report";
import { listSinks, outputDelay, pwCatPlayer, type OutputDelay } from "./player";
import { AUDIO_PORT, DISCOVERY_PORT, UI_PORT } from "./protocol";
import { AudioServer, type LiveMetrics } from "./server";
import { WebUI } from "./web";
import { SessionNotifier, notifySend } from "./notify";
import { UsbBridge } from "./usb";

const VERSION = "0.9.0";
let config: Config = loadConfig();

/** Container, VM and VPN-internal bridges a phone on the LAN can never reach. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|waydroid|lxc|lxd|podman|cni|flannel|tun|tap)/;

function addresses(): { iface: string; address: string }[] {
  const out: { iface: string; address: string }[] = [];
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(iface)) continue;
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

/** Exit code 0 = yes, 1 = no (firewall-cmd query convention); anything else = could not tell. */
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 3000 }, (err, out) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1;
      resolve({ code, out: String(out).trim() });
    }),
  );
}

/** "open" | "blocked" | "unknown" (firewalld missing, not running, or a query failed). */
let firewall: "open" | "blocked" | "unknown" = "unknown";

/** True if the zone allows the port, either directly or through a port range. */
async function zoneAllows(zone: string, port: number, proto: string): Promise<boolean | null> {
  const q = await run("firewall-cmd", [`--zone=${zone}`, `--query-port=${port}/${proto}`]);
  if (q.code === 0) return true;
  if (q.code !== 1) return null;
  const list = await run("firewall-cmd", [`--zone=${zone}`, "--list-ports"]);
  if (list.code !== 0) return null;
  return list.out.split(/\s+/).some((p) => {
    const [range, pr] = p.split("/");
    if (pr !== proto || !range) return false;
    const [lo, hi = lo] = range.split("-").map(Number);
    return port >= lo! && port <= hi!;
  });
}

async function checkFirewall() {
  if ((await run("firewall-cmd", ["--state"])).code !== 0) return void setFirewall("unknown");
  // Check the zone each LAN interface actually sits in, not just the default zone.
  const zones = new Set<string>();
  for (const { iface } of addresses()) {
    const z = await run("firewall-cmd", [`--get-zone-of-interface=${iface}`]);
    if (z.code === 0 && z.out) zones.add(z.out);
  }
  if (zones.size === 0) {
    const d = await run("firewall-cmd", ["--get-default-zone"]);
    if (d.code !== 0 || !d.out) return void setFirewall("unknown");
    zones.add(d.out);
  }
  let open = true;
  for (const zone of zones) {
    for (const [port, proto] of [[AUDIO_PORT, "tcp"], [DISCOVERY_PORT, "udp"]] as const) {
      const ok = await zoneAllows(zone, port, proto);
      if (ok === null) return void setFirewall("unknown");
      if (!ok) open = false;
    }
  }
  setFirewall(open ? "open" : "blocked");
}

function setFirewall(next: typeof firewall) {
  if (next !== firewall) log("firewall", { state: next });
  firewall = next;
}

let ui: WebUI;
/** What the output device adds after Dhvani's own buffer (Bluetooth can add 100-250 ms). */
let output: OutputDelay | null = null;
async function probeOutput() {
  const next = server.session ? await outputDelay(config.latency) : null;
  if (JSON.stringify(next) === JSON.stringify(output)) return;
  output = next;
  if (next) log("output_delay", { ...next });
  pushState();
}
/**
 * True while the output picked in the panel is gone, e.g. the Bluetooth headset was switched
 * off or walked out of range. PipeWire would move the stream to the speakers, often at a
 * volume set for headphones, so Dhvani plays silence until the device is back.
 */
let outputMissing = false;
async function checkPinnedOutput() {
  let missing = false;
  if (config.sink && server.session) {
    const { sinks } = await listSinks();
    missing = sinks.length > 0 && !sinks.some((s) => s.name === config.sink);
  }
  if (missing === outputMissing) return;
  outputMissing = missing;
  log(missing ? "output_missing" : "output_back", { sink: config.sink });
  // Reopen playback so the stream goes back to the chosen device, not wherever PipeWire parked it.
  if (!missing) {
    server.restartPlayer();
    setTimeout(probeOutput, 2000);
  }
  pushState();
}
let lastLevelSent = 0;
/** Last five minutes of one-second readings, so a freshly opened panel has a chart. */
const METRICS_KEEP = 300;
const metrics: LiveMetrics[] = [];
const pushState = () => void state().then((s) => ui?.broadcast("state", s));
const notifier = new SessionNotifier(notifySend, () => config.notify);
const usb = new UsbBridge(AUDIO_PORT, () => config.usb, pushState);
const server = new AudioServer(() => config, pwCatPlayer, {
  onChange: pushState,
  onLevel: (frame) => {
    lastLevelSent = frame.peak;
    ui?.broadcast("level", { ...frame, drops: server.drops });
  },
  onMetrics: (m) => {
    metrics.push(m);
    if (metrics.length > METRICS_KEEP) metrics.shift();
    ui?.broadcast("metrics", m);
  },
  onControl: (c) => apply(sanitize(c, config)),
  onSessionStart: (s) => {
    metrics.length = 0;
    setTimeout(probeOutput, 2000);
    notifier.started(s.device);
  },
  onSessionEnd: (s, reason) => notifier.ended(s.device, reason),
  addresses: () => addresses().map((a) => a.address),
  outputMissing: () => outputMissing,
});

// pactl takes ~0.2-0.5 s; volume drags and level-driven state pushes must not wait on it each time.
const SINK_TTL_MS = 3000;
let sinkCache: { at: number; value: ReturnType<typeof listSinks> } | null = null;
function cachedSinks() {
  if (!sinkCache || Date.now() - sinkCache.at > SINK_TTL_MS) sinkCache = { at: Date.now(), value: listSinks() };
  return sinkCache.value;
}

async function state() {
  const { sinks, defaultSink } = await cachedSinks();
  return {
    version: VERSION,
    name: config.name,
    code: config.code,
    sink: config.sink,
    volume: config.volume,
    muted: config.muted,
    followPhone: config.followPhone,
    latency: config.latency,
    notify: config.notify,
    usb: config.usb,
    sinks,
    defaultSink,
    port: AUDIO_PORT,
    addresses: addresses(),
    session: server.session,
    drops: server.drops,
    level: lastLevelSent,
    lastError: server.lastError,
    quality: server.quality,
    phone: server.phone,
    recent: server.recent,
    output,
    outputMissing,
    firewallFix: `sudo firewall-cmd --permanent --add-port=${AUDIO_PORT}/tcp --add-port=${DISCOVERY_PORT}/udp && sudo firewall-cmd --reload`,
    health: {
      listening: server.listening,
      discovery: server.discovery,
      firewall,
      adb: usb.available,
      usbPhones: usb.phones.length,
    },
  };
}

function apply(next: Config) {
  const sinkChanged = next.sink !== config.sink;
  const codeChanged = next.code !== config.code;
  const changed: Record<string, unknown> = {};
  for (const k of ["sink", "volume", "muted", "followPhone", "name", "latency", "notify", "usb"] as const) {
    if (next[k] !== config[k]) changed[k] = next[k];
  }
  const laptopChanged = next.volume !== config.volume || next.muted !== config.muted;
  const latencyChanged = next.latency !== config.latency;
  const usbChanged = next.usb !== config.usb;
  if (codeChanged) changed.code = "changed"; // never log the code itself
  config = next;
  saveConfig(config);
  if (Object.keys(changed).length) log("settings", changed);
  if (sinkChanged) server.restartPlayer();
  if (sinkChanged || latencyChanged) setTimeout(probeOutput, 2000);
  if (laptopChanged) server.pushLaptopState();
  if (latencyChanged) server.setLatency(config.latency);
  if (usbChanged) void usb.tick();
  pushState();
  if (codeChanged) server.disconnect("code_changed");
}

ui = new WebUI({
  state,
  updateSettings(input) {
    // The code is only changed through "New code", never typed in.
    const { code: _ignored, ...rest } = input as Partial<Config>;
    apply(sanitize(rest, config));
  },
  newCode() {
    apply({ ...config, code: newCode() });
  },
  disconnect() {
    server.disconnect("disconnected");
  },
  history() {
    // Reading ~10 MB of log on every panel load adds up; half a minute stale is fine.
    if (!historyCache || Date.now() - historyCache.at > 30_000) {
      historyCache = { at: Date.now(), sessions: sessionHistory(LOG_FILE, 14) };
    }
    return { metrics, sessions: historyCache.sessions };
  },
});
let historyCache: { at: number; sessions: ReturnType<typeof sessionHistory> } | null = null;

async function main() {
  if (process.argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (process.argv[2] === "report") {
    report(LOG_FILE, process.argv.slice(3));
    return;
  }
  // Logged before listening: a phone may reconnect the instant the port opens,
  // and `dhvani report` treats "start" as the boundary where session ids restart.
  log("start", {
    version: VERSION,
    addresses: addresses().map((a) => `${a.iface}=${a.address}`),
    sink: config.sink || "default",
    volume: config.volume,
  });
  server.recent = recentSessions(LOG_FILE, 6);
  try {
    await server.listen(AUDIO_PORT);
  } catch (e) {
    console.error(`Could not listen on TCP ${AUDIO_PORT}: ${(e as Error).message}. Is Dhvani already running?`);
    process.exit(1);
  }
  try {
    await server.listenDiscovery(DISCOVERY_PORT, AUDIO_PORT);
  } catch (e) {
    console.error(`Discovery unavailable on UDP ${DISCOVERY_PORT}: ${(e as Error).message}`);
  }
  try {
    ui.listen(UI_PORT);
  } catch (e) {
    console.error(`Control panel unavailable on ${UI_PORT}: ${(e as Error).message}`);
  }
  usb.start();
  await checkFirewall();
  setInterval(checkFirewall, 60_000).unref();
  setInterval(probeOutput, 10_000).unref();
  setInterval(checkPinnedOutput, 2000).unref();
  console.log(`Dhvani ${VERSION} listening on TCP ${AUDIO_PORT}, panel http://127.0.0.1:${UI_PORT}`);
  console.log(`Pairing code ${config.code}. Addresses: ${addresses().map((a) => a.address).join(", ") || "none"}`);


  const stop = () => {
    server.close();
    usb.stop();
    notifier.close();
    log("stop");
    ui.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
