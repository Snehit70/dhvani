/**
 * End-to-end tests against the real Android app on an emulator (or a phone over adb).
 * A laptop server runs in this process on spare ports; the app streams to it through 10.0.2.2.
 * Every test fails if anything lands in the device's crash log. Run with android/e2e.sh.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import type { Player, PlayerFactory } from "../../src/player";
import { AudioServer } from "../../src/server";

const E2E = !!process.env.DHVANI_E2E;
const PKG = "dev.snehit.dhvani";
const SERVICE = `${PKG}/.StreamService`;
const CONTROL = `${PKG}.CONTROL`;
const AUDIO_PORT = Number(process.env.DHVANI_E2E_PORT ?? 47900);
const UDP_PORT = AUDIO_PORT + 3;
const HOST = process.env.DHVANI_E2E_HOST ?? "10.0.2.2";
const CODE = "135790";

const cfg: Config = {
  code: CODE, sink: "", volume: 1, muted: false, followPhone: false, name: "e2e-laptop",
  latency: "stable", notify: false, usb: false,
};

let audioBytes = 0;
const factory: PlayerFactory = () => {
  let closed = false;
  return {
    get closed() { return closed; },
    write(pcm: Uint8Array) { audioBytes += pcm.length; return "ok" as const; },
    leadMs: 0, underruns: 0, compressedMs: 0, targetMs: 100,
    setLatency() {}, close() { closed = true; },
  } satisfies Player;
};

const controls: { volume?: number; muted?: boolean }[] = [];
let server: AudioServer;
async function startServer() {
  server = new AudioServer(() => cfg, factory, {
    onChange: () => {}, onLevel: () => {}, addresses: () => [], allowUdp: () => true,
    onControl: (c) => {
      controls.push(c);
      if (c.volume !== undefined) cfg.volume = c.volume;
      if (c.muted !== undefined) cfg.muted = c.muted;
      server.pushLaptopState();
    },
  });
  await server.listen(AUDIO_PORT, "127.0.0.1");
  await server.listenDiscovery(UDP_PORT, AUDIO_PORT);
}

// ---- adb helpers ----
function adb(...args: string[]): string {
  const r = Bun.spawnSync(["adb", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")} failed: ${r.stderr.toString() || out}`);
  return out;
}
const sh = (cmd: string) => adb("shell", cmd);
const alive = () => sh(`pidof ${PKG} || true`).trim() !== "";
/** Crash-log entries from this app; other processes on a fresh emulator crash sometimes too. */
const crashes = () => {
  const log = adb("logcat", "-b", "crash", "-d");
  return log.includes(`Process: ${PKG}`) || log.includes(`${PKG} `) ? log.trim() : "";
};

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

type Node = { text: string; desc: string; cls: string; x: number; y: number; x1: number; x2: number };
function screen(): Node[] {
  sh("uiautomator dump /sdcard/dhvani-ui.xml >/dev/null");
  const xml = sh("cat /sdcard/dhvani-ui.xml");
  const nodes: Node[] = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const a = (k: string) => m[0].match(new RegExp(` ${k}="([^"]*)"`))?.[1] ?? "";
    const b = a("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number) as [number, number, number, number];
    nodes.push({ text: a("text"), desc: a("content-desc"), cls: a("class"), x: (x1 + x2) >> 1, y: (y1 + y2) >> 1, x1, x2 });
  }
  return nodes;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const find = (label: string | RegExp, nodes = screen()) =>
  nodes.find((n) => (typeof label === "string" ? same(n.text, label) || same(n.desc, label) : label.test(n.text) || label.test(n.desc)));
const visible = () => screen().map((n) => n.text || n.desc).filter(Boolean).join(" | ");
/** A cold emulator often shows "X isn't responding" for system apps; wait past it. */
function dismissSystemDialog(nodes: Node[]): boolean {
  if (!nodes.some((n) => /isn.t responding|keeps stopping|has stopped/i.test(n.text))) return false;
  const wait = nodes.find((n) => /^(wait|close app|ok)$/i.test(n.text));
  if (wait) tap(wait);
  return true;
}
async function waitFor(label: string | RegExp, ms = 10_000): Promise<Node> {
  let n: Node | undefined;
  try {
    await until(`"${label}" on screen`, () => {
      const nodes = screen();
      if (dismissSystemDialog(nodes)) return false;
      return !!(n = find(label, nodes));
    }, ms);
  } catch (e) {
    const top = sh("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' || true").trim();
    throw new Error(`${(e as Error).message}\n  top: ${top}\n  screen: ${visible()}`);
  }
  return n!;
}
/** A slow swipe, so the list doesn't fling, then a pause so positions read next are where taps land. */
async function scroll(path: string) {
  sh(`input swipe ${path} 900`);
  await Bun.sleep(600);
}
/** Scrolls the page up to the top, then down, until the label is on screen. */
async function scrollTo(label: string | RegExp, pick = find): Promise<Node> {
  const swipes = ["540 800 540 1700", "540 800 540 1700", "540 800 540 1700",
    "540 1600 540 900", "540 1600 540 900", "540 1600 540 900", "540 1600 540 900", "540 1600 540 900"];
  for (let i = 0, dialogs = 0; i <= swipes.length; i++) {
    const nodes = screen();
    if (dismissSystemDialog(nodes) && dialogs++ < 5) { i--; await Bun.sleep(500); continue; }
    const n = pick(label, nodes);
    if (n) return n;
    if (i < swipes.length) await scroll(swipes[i]!);
  }
  return waitFor(label, 3000);
}
const findSlider = (l: string | RegExp, nodes = screen()) => nodes.find((n) => n.cls.endsWith("SeekBar") && n.desc === l);
/** The volume slider, scrolled into the middle of the screen, clear of the gesture-nav edge. */
async function slider(): Promise<Node> {
  let bar = await scrollTo("Laptop volume", findSlider);
  for (let i = 0; i < 4 && (bar.y > 1700 || bar.y < 400); i++) {
    await scroll(bar.y > 1700 ? "540 1500 540 1000" : "540 1000 540 1500");
    bar = await scrollTo("Laptop volume", findSlider);
  }
  return bar;
}
/** A real finger drag: down, eight moves, up. */
function drag(y: number, fromX: number, toX: number) {
  const xs = Array.from({ length: 9 }, (_, i) => Math.round(fromX + ((toX - fromX) * i) / 8));
  y = Math.round(y);
  sh([`input motionevent DOWN ${xs[0]} ${y}`, ...xs.slice(1).map((x) => `input motionevent MOVE ${x} ${y}`),
    `input motionevent UP ${xs[8]} ${y}`].join("; "));
}
const tap = (n: Node) => sh(`input tap ${n.x} ${n.y}`);

function launch() {
  sh(`am start -W -n ${PKG}/.MainActivity`);
}

async function startStreaming() {
  launch();
  const start = await scrollTo(/^(Start streaming|Try again)$/i);
  tap(start);
  // The share prompt is skipped by the PROJECT_MEDIA app-op; tap through it if it shows anyway.
  const end = Date.now() + 15_000;
  while (!server.session && Date.now() < end) {
    const ok = find(/^(Start|Start now|START NOW)$/);
    if (ok && !alive()) break;
    if (ok && !/streaming/i.test(ok.text)) tap(ok);
    await Bun.sleep(300);
  }
  await until("the phone to connect", () => !!server.session, 15_000);
  await until("audio to arrive", () => audioBytes > 0, 10_000);
}

describe.skipIf(!E2E)("Android app end to end", () => {
  beforeAll(async () => {
    await startServer();
    adb("root");
    adb("wait-for-device");
    sh(`am force-stop ${PKG}`);
    sh(`pm grant ${PKG} android.permission.RECORD_AUDIO`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh(`appops set ${PKG} PROJECT_MEDIA allow`);
    sh("settings put system accelerometer_rotation 0; settings put system user_rotation 0");
    const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="host">${HOST}:${AUDIO_PORT}</string>
    <string name="code">${CODE}</string>
    <boolean name="silence" value="false" />
    <boolean name="reconnect" value="true" />
    <boolean name="autoConnect" value="false" />
</map>`;
    const dir = `/data/data/${PKG}/shared_prefs`;
    sh(`mkdir -p ${dir} && cat > ${dir}/dhvani.xml <<'XML'\n${prefs}\nXML\nchown -R $(stat -c %u:%g /data/data/${PKG}) ${dir}; chmod 660 ${dir}/dhvani.xml; restorecon -R ${dir}`);
    adb("logcat", "-b", "crash", "-c");
    await startStreaming();
  }, 60_000);

  afterAll(() => {
    try { sh(`am force-stop ${PKG}`); } catch {}
    server?.close();
  });

  const healthy = () => {
    expect(crashes()).toBe("");
    expect(alive()).toBe(true);
  };

  test("streams over UDP to the laptop", () => {
    expect(server.session?.transport).toBe("udp");
    expect(server.session?.device).toBeTruthy();
    healthy();
  });

  test("dragging the laptop volume slider sends volume and does not crash", async () => {
    controls.length = 0;
    launch();
    const bar = await slider();
    const w = bar.x2 - bar.x1;
    drag(bar.y, bar.x1 + w * 0.8, bar.x1 + w * 0.3);
    try {
      await until("a volume control", () => controls.some((c) => c.volume !== undefined && c.muted === undefined));
    } catch (e) {
      throw new Error(`${(e as Error).message}; slider at ${JSON.stringify(bar)}; got ${JSON.stringify(controls)}; screen: ${visible()}`);
    }
    await Bun.sleep(500);
    healthy();
    const last = controls.at(-1)!.volume!;
    expect(last).toBeGreaterThan(0.25);
    expect(last).toBeLessThan(0.7);
  }, 30_000);

  test("tapping the slider sends one volume", async () => {
    controls.length = 0;
    const bar = await slider();
    sh(`input tap ${bar.x1 + Math.round((bar.x2 - bar.x1) * 0.9)} ${bar.y}`);
    await until("a volume control", () => controls.some((c) => c.volume !== undefined));
    await Bun.sleep(500);
    healthy();
  }, 30_000);

  test("mute and unmute from the app", async () => {
    controls.length = 0;
    tap(await scrollTo("Mute"));
    await until("mute", () => controls.some((c) => c.muted === true));
    tap(await waitFor("Unmute"));
    await until("unmute", () => controls.some((c) => c.muted === false));
    await waitFor("Mute");
    healthy();
  }, 30_000);

  test("a volume change on the laptop shows on the phone", async () => {
    cfg.volume = 0.65;
    cfg.muted = false;
    server.pushLaptopState();
    await waitFor("65%");
    cfg.muted = true;
    server.pushLaptopState();
    await waitFor("Muted");
    cfg.muted = false;
    server.pushLaptopState();
    await waitFor("65%");
    healthy();
  }, 30_000);

  test("odd control intents are ignored, not fatal", async () => {
    const intents = [
      "--ef volume 0.4",
      "--ez muted true",
      "--ez muted false",
      "--ez toggleMute true",
      "--ez toggleMute true",
      "--ez toggleMute false",
      "",
      "--ef volume NaN",
      "--ef volume 99",
      "--ef volume -3",
      "--es volume loud",
      "--ei volume 1",
      "--es muted yes",
      "--ef volume 0.5 --ez muted false",
    ];
    for (const extras of intents) {
      sh(`am startservice -n ${SERVICE} -a ${CONTROL} ${extras}`);
      await Bun.sleep(150);
      expect(crashes()).toBe("");
    }
    await Bun.sleep(500);
    healthy();
    expect(server.session).toBeTruthy();
    for (const c of controls) {
      if (c.volume !== undefined) {
        expect(c.volume).toBeGreaterThanOrEqual(0);
        expect(c.volume).toBeLessThanOrEqual(1.5);
      }
    }
  }, 30_000);

  test("hardware volume keys while streaming", async () => {
    for (const k of ["VOLUME_UP", "VOLUME_DOWN", "VOLUME_MUTE", "VOLUME_MUTE"]) sh(`input keyevent ${k}`);
    await Bun.sleep(500);
    healthy();
  }, 30_000);

  test("rotating, backgrounding and reopening the app keeps streaming", async () => {
    sh("settings put system user_rotation 1");
    await Bun.sleep(1500);
    sh("settings put system user_rotation 0");
    await Bun.sleep(1000);
    sh("input keyevent HOME");
    await Bun.sleep(800);
    launch();
    await slider();
    expect(server.session).toBeTruthy();
    healthy();
  }, 30_000);

  test("the phone reconnects after the laptop restarts", async () => {
    server.close();
    await Bun.sleep(1500);
    await startServer();
    await until("the phone to reconnect", () => !!server.session, 30_000);
    const before = audioBytes;
    await until("audio after reconnect", () => audioBytes > before, 10_000);
    healthy();
  }, 60_000);

  test("a wrong code stops streaming with an error, not a crash", async () => {
    const real = cfg.code;
    cfg.code = "000000";
    server.disconnect();
    await Bun.sleep(4000);
    expect(server.session).toBeNull();
    expect(crashes()).toBe("");
    cfg.code = real;
    audioBytes = 0;
    await startStreaming();
    healthy();
  }, 60_000);

  test("stop from the app ends the session", async () => {
    launch();
    tap(await scrollTo("Stop"));
    await until("the session to end", () => !server.session);
    await scrollTo("Start streaming");
    healthy();
  }, 30_000);

  test("monkey run over the app", async () => {
    await startStreaming();
    sh(`monkey -p ${PKG} --pct-syskeys 0 --pct-appswitch 0 --throttle 40 -s 7 -v 600 >/dev/null 2>&1 || true`);
    await Bun.sleep(1000);
    expect(crashes()).toBe("");
  }, 120_000);
});
