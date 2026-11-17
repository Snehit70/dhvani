import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { loadConfig, newCode, sanitize, saveConfig, type Config } from "./config";
import { listSinks, pwCatPlayer } from "./player";
import { AUDIO_PORT, DISCOVERY_PORT, UI_PORT } from "./protocol";
import { AudioServer } from "./server";
import { WebUI } from "./web";

const VERSION = "0.1.0";
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
  if ((await run("firewall-cmd", ["--state"])).code !== 0) return void (firewall = "unknown");
  // Check the zone each LAN interface actually sits in, not just the default zone.
  const zones = new Set<string>();
  for (const { iface } of addresses()) {
    const z = await run("firewall-cmd", [`--get-zone-of-interface=${iface}`]);
    if (z.code === 0 && z.out) zones.add(z.out);
  }
  if (zones.size === 0) {
    const d = await run("firewall-cmd", ["--get-default-zone"]);
    if (d.code !== 0 || !d.out) return void (firewall = "unknown");
    zones.add(d.out);
  }
  let open = true;
  for (const zone of zones) {
    for (const [port, proto] of [[AUDIO_PORT, "tcp"], [DISCOVERY_PORT, "udp"]] as const) {
      const ok = await zoneAllows(zone, port, proto);
      if (ok === null) return void (firewall = "unknown");
      if (!ok) open = false;
    }
  }
  firewall = open ? "open" : "blocked";
}

let ui: WebUI;
let lastLevelSent = 0;
const server = new AudioServer(() => config, pwCatPlayer, {
  onChange: () => void state().then((s) => ui?.broadcast("state", s)),
  onLevel: (peak) => {
    lastLevelSent = peak;
    ui?.broadcast("level", { peak, drops: server.drops });
  },
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
    sinks,
    defaultSink,
    port: AUDIO_PORT,
    addresses: addresses(),
    session: server.session,
    drops: server.drops,
    level: lastLevelSent,
    lastError: server.lastError,
    health: {
      listening: server.listening,
      discovery: server.discovery,
      firewall,
    },
  };
}

function apply(next: Config) {
  const sinkChanged = next.sink !== config.sink;
  const codeChanged = next.code !== config.code;
  config = next;
  saveConfig(config);
  if (sinkChanged) server.restartPlayer();
  if (codeChanged) server.disconnect();
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
    server.disconnect();
  },
});

async function main() {
  if (process.argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
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
  await checkFirewall();
  setInterval(checkFirewall, 60_000).unref();
  console.log(`Dhvani ${VERSION} listening on TCP ${AUDIO_PORT}, panel http://127.0.0.1:${UI_PORT}`);
  console.log(`Pairing code ${config.code}. Addresses: ${addresses().map((a) => a.address).join(", ") || "none"}`);

  const stop = () => {
    server.close();
    ui.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
