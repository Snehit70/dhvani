import { execFile } from "node:child_process";
import { log } from "./log";

type Run = (args: string[]) => Promise<{ ok: boolean; out: string; missing: boolean }>;

const runAdb: Run = (args) =>
  new Promise((resolve) =>
    execFile("adb", args, { timeout: 4000 }, (err, out) =>
      resolve({
        ok: !err,
        out: String(out ?? ""),
        missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
      }),
    ),
  );

/** Serials of phones attached by cable. Wireless-debugging ones already reach the laptop over Wi-Fi. */
export function usbSerials(devicesOutput: string): string[] {
  const out: string[] = [];
  for (const line of devicesOutput.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || state !== "device") continue;
    if (serial.includes(":") || serial.includes("._adb-tls")) continue;
    out.push(serial);
  }
  return out;
}

/**
 * Keeps `adb reverse tcp:PORT tcp:PORT` in place for every USB-attached phone,
 * so the phone app can stream to 127.0.0.1 through the cable. Turning USB off,
 * or stopping, removes the mappings again.
 */
export class UsbBridge {
  /** Serials with a working reverse. */
  phones: string[] = [];
  available = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  /** Serials that have Dhvani's reverse mapping, to remove when USB is turned off. */
  private mapped = new Set<string>();
  /** Bumped by stop(): a sync already running must not put mappings back afterwards. */
  private generation = 0;

  constructor(
    private port: number,
    private enabled: () => boolean,
    private onChange: () => void,
    private run: Run = runAdb,
  ) {}

  start(intervalMs = 5000) {
    const gen = this.generation;
    const loop = async () => {
      await this.tick();
      if (gen !== this.generation) return;
      // Without adb installed, look again only occasionally.
      this.timer = setTimeout(loop, this.available ? intervalMs : 60_000);
      this.timer.unref?.();
    };
    void loop();
  }

  /** Stops polling and removes the mappings Dhvani made (best effort, bounded by adb's timeout). */
  async stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.unmapAll();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.sync();
    } finally {
      this.busy = false;
    }
  }

  private async sync() {
    const gen = this.generation;
    if (!this.enabled()) {
      await this.unmapAll();
      return this.set([]);
    }
    const devices = await this.run(["devices"]);
    this.available = !devices.missing;
    if (!devices.ok) return this.set([]);
    const ready: string[] = [];
    const want = `tcp:${this.port} tcp:${this.port}`;
    for (const serial of usbSerials(devices.out)) {
      // Turned off or stopped while adb ran: leave the rest alone.
      if (gen !== this.generation || !this.enabled()) break;
      const list = await this.run(["-s", serial, "reverse", "--list"]);
      if (list.ok && list.out.includes(want)) {
        this.mapped.add(serial);
        ready.push(serial);
        continue;
      }
      const r = await this.run(["-s", serial, "reverse", `tcp:${this.port}`, `tcp:${this.port}`]);
      log("usb_reverse", { ok: r.ok });
      if (r.ok) {
        this.mapped.add(serial);
        ready.push(serial);
      }
    }
    if (gen !== this.generation || !this.enabled()) {
      await this.unmapAll();
      return this.set([]);
    }
    this.set(ready);
  }

  private async unmapAll() {
    const serials = [...this.mapped];
    this.mapped.clear();
    for (const serial of serials) {
      const r = await this.run(["-s", serial, "reverse", "--remove", `tcp:${this.port}`]);
      log("usb_reverse_removed", { ok: r.ok });
    }
  }

  private set(next: string[]) {
    if (next.join() === this.phones.join()) return;
    this.phones = next;
    this.onChange();
  }
}
