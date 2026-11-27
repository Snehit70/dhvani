import { existsSync, readFileSync } from "node:fs";

type Ev = Record<string, unknown> & { t: string; ev: string };
type Row = {
  id: number; start: string; device: string; durationS: number; reason: string;
  drops: number; underruns: number; targetMaxMs: number; gapMaxMs: number; gaps100: number;
  minRatePct: number; maxLeadMs: number; playerExits: number;
  rssiMin: number | null; linkMin: number | null; writeMaxMs: number; stalls: number; reconnects: number;
  /** The phone's run totals when this session began; its stats count from there. */
  base: PhoneCounts;
};
type PhoneCounts = { stalls: number; reconnects: number };

function readEvents(file: string): Ev[] {
  const out: Ev[] = [];
  for (const f of [`${file}.1`, file]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Ev;
        if (e && typeof e.ev === "string") out.push(e);
      } catch {}
    }
  }
  return out;
}

/** Last `n` finished sessions from the log, newest first, for the panel after a restart. */
export function recentSessions(file: string, n: number) {
  const starts = new Map<number, Ev>();
  const out: { device: string; start: number; durationS: number; reason: string; drops: number; underruns: number }[] = [];
  for (const e of readEvents(file)) {
    if (e.ev === "start") starts.clear();
    if (e.ev === "session_start") starts.set(num(e.session), e);
    if (e.ev === "session_end") {
      const s = starts.get(num(e.session));
      if (!s) continue;
      out.push({
        device: String(s.device ?? "Phone"), start: Date.parse(s.t), durationS: num(e.durationS),
        reason: String(e.reason), drops: num(e.drops), underruns: num(e.underruns),
      });
    }
  }
  return out.slice(-n).reverse();
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** One row per session in the log, oldest first, with what went wrong in it. */
function buildRows(events: Ev[]): { rows: Row[]; rejected: number } {
  const rows = new Map<number, Row>();
  // Session ids restart with the service, so key on start order instead.
  let current = new Map<number, Row>();
  let seq = 0;
  let rejected = 0;
  // The phone counts stalls and reconnects since Start was tapped, across sessions. Keep its
  // last totals per device so each session gets only what happened since the one before.
  const phoneTotals = new Map<string, PhoneCounts>();
  for (const e of events) {
    if (e.ev === "start") current = new Map();
    if (e.ev === "hello_rejected") rejected++;
    const sid = num(e.session);
    if (e.ev === "session_start") {
      const r: Row = {
        id: ++seq, start: e.t, device: String(e.device ?? "?"), durationS: 0, reason: "running",
        drops: 0, underruns: 0, targetMaxMs: 0, gapMaxMs: 0, gaps100: 0, minRatePct: Infinity, maxLeadMs: 0, playerExits: 0,
        rssiMin: null, linkMin: null, writeMaxMs: 0, stalls: 0, reconnects: 0,
        base: phoneTotals.get(String(e.device ?? "?")) ?? { stalls: 0, reconnects: 0 },
      };
      current.set(sid, r);
      rows.set(r.id, r);
      continue;
    }
    const r = current.get(sid);
    if (!r) continue;
    switch (e.ev) {
      case "session_stats":
        r.gapMaxMs = Math.max(r.gapMaxMs, num(e.gapMaxMs));
        r.gaps100 += num(e.gaps100);
        r.maxLeadMs = Math.max(r.maxLeadMs, num(e.leadMaxMs));
        r.targetMaxMs = Math.max(r.targetMaxMs, num(e.targetMs));
        if (num(e.secs) >= 5) r.minRatePct = Math.min(r.minRatePct, num(e.ratePct));
        break;
      case "player_exit":
        r.playerExits++;
        break;
      case "phone_stats":
        if (typeof e.rssi === "number") r.rssiMin = r.rssiMin === null ? e.rssi : Math.min(r.rssiMin, e.rssi);
        if (typeof e.linkMbps === "number" && e.linkMbps > 0)
          r.linkMin = r.linkMin === null ? e.linkMbps : Math.min(r.linkMin, e.linkMbps);
        r.writeMaxMs = Math.max(r.writeMaxMs, num(e.writeMaxMs));
        {
          const cur = { stalls: num(e.stalls), reconnects: num(e.reconnects) };
          // Lower than before: Start was tapped again and the phone's totals restarted from 0.
          if (cur.stalls < r.base.stalls || cur.reconnects < r.base.reconnects) r.base = { stalls: 0, reconnects: 0 };
          r.stalls = Math.max(r.stalls, cur.stalls - r.base.stalls);
          r.reconnects = Math.max(r.reconnects, cur.reconnects - r.base.reconnects);
          phoneTotals.set(r.device, cur);
        }
        break;
      case "session_end":
        r.durationS = num(e.durationS);
        r.reason = String(e.reason);
        r.drops = num(e.drops);
        r.underruns = num(e.underruns);
        current.delete(sid);
        break;
    }
  }
  return { rows: [...rows.values()], rejected };
}

/** Sessions that started within the last `days` days, newest first, for the panel's history view. */
export function sessionHistory(file: string, days: number) {
  const since = Date.now() - days * 86_400_000;
  return buildRows(readEvents(file))
    .rows.filter((r) => Date.parse(r.start) >= since)
    .reverse()
    .map((r) => ({
      device: r.device,
      start: Date.parse(r.start),
      durationS: r.durationS,
      reason: r.reason,
      drops: r.drops,
      underruns: r.underruns,
      gaps100: r.gaps100,
      gapMaxMs: Math.round(r.gapMaxMs),
      targetMaxMs: r.targetMaxMs,
      rssiMin: r.rssiMin,
      reconnects: r.reconnects,
    }));
}

/** `dhvani report [N]`: one line per recent session plus what went wrong in it. */
export function report(file: string, args: string[]) {
  const events = readEvents(file);
  if (!events.length) return void console.log(`No events yet in ${file}`);
  const limit = Number(args[0]) > 0 ? Number(args[0]) : 10;
  const { rows, rejected } = buildRows(events);
  const list = rows.slice(-limit);
  const pad = (s: unknown, n: number) => String(s).slice(0, n).padEnd(n);
  console.log(
    pad("when", 17) + pad("device", 18) + pad("mins", 7) + pad("end", 14) + pad("drops", 7) + pad("gaps", 6) +
      pad("worst", 8) + pad("rate%", 7) + pad("rssi", 6) + pad("phone", 8) + "notes",
  );
  for (const r of list) {
    const notes: string[] = [];
    if (r.underruns) notes.push(`${r.underruns} underruns`);
    if (r.targetMaxMs) notes.push(`buffer up to ${Math.round(r.targetMaxMs)} ms`);
    if (r.playerExits) notes.push(`pw-cat died ${r.playerExits}x`);
    if (r.stalls) notes.push(`${r.stalls} phone stalls`);
    if (r.reconnects) notes.push(`${r.reconnects} ${r.reconnects === 1 ? "retry" : "retries"} to connect`);
    if (r.linkMin !== null && r.linkMin < 50) notes.push(`link ${r.linkMin} Mbps`);
    console.log(
      pad(r.start.replace("T", " ").slice(0, 16), 17) + pad(r.device, 18) + pad((r.durationS / 60).toFixed(1), 7) +
        pad(r.reason, 14) + pad(r.drops, 7) + pad(r.gaps100, 6) + pad(`${Math.round(r.gapMaxMs)}ms`, 8) +
        pad(Number.isFinite(r.minRatePct) ? r.minRatePct : "-", 7) + pad(r.rssiMin ?? "-", 6) +
        pad(r.writeMaxMs ? `${r.writeMaxMs}ms` : "-", 8) + notes.join(", "),
    );
  }
  console.log(
    `\ngaps = data gaps over 100 ms (Wi-Fi hiccups); worst = longest gap; rate% = slowest 10 s window ` +
      `(100 = real time); phone = longest single socket write on the phone. Times are UTC.` +
      `\nretries to connect = connection drops and failed attempts on the phone since its session before.` +
      (rejected ? `\n${rejected} connection attempts rejected (wrong code, timeout or bad hello).` : "") +
      `\nRaw events: ${file}`,
  );
}
