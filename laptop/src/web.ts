import pageText from "./ui.html" with { type: "text" };

// With { type: "text" } Bun inlines the file as a string; its typings still say HTMLBundle.
const page = pageText as unknown as string;

export type WebDeps = {
  state(): Promise<unknown> | unknown;
  updateSettings(input: Record<string, unknown>): Promise<void> | void;
  newCode(): void;
  disconnect(): void;
  /** Live chart backlog and past sessions for the analytics view. */
  history?(): unknown;
};

type Client = { sendRaw(bytes: Uint8Array): void; send(event: string, data: unknown): void; close(): void };

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
/** A panel this many events behind (a frozen or backgrounded tab) is dropped; it reconnects on its own. */
export const MAX_CLIENT_QUEUE = 256;

/** Local-only control panel. Rejects foreign Host/Origin to block DNS-rebinding and CSRF. */
export class WebUI {
  private clients = new Set<Client>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private deps: WebDeps) {}

  listen(port: number): number {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const host = req.headers.get("host") || "";
        if (!allowedHosts.has(host) && !allowedHosts.has(`${host}:${port}`)) {
          return new Response("Forbidden", { status: 403 });
        }
        if (req.method === "POST") {
          const origin = req.headers.get("origin");
          if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
            return new Response("Forbidden", { status: 403 });
          }
          if (!(req.headers.get("content-type") || "").startsWith("application/json")) {
            return new Response("Unsupported Media Type", { status: 415 });
          }
        }
        return this.route(req, url);
      },
    });
    return this.server.port ?? port;
  }

  close() {
    for (const c of this.clients) c.close();
    this.server?.stop(true);
  }

  /** Open live-update connections (panels). */
  get listeners(): number {
    return this.clients.size;
  }

  broadcast(event: string, data: unknown) {
    if (!this.clients.size) return;
    const bytes = frame(event, data);
    for (const c of this.clients) c.sendRaw(bytes);
  }

  private async route(req: Request, url: URL): Promise<Response> {
    const json = (d: unknown, status = 200) =>
      new Response(JSON.stringify(d), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    const key = `${req.method} ${url.pathname}`;
    switch (key) {
      case "GET /":
        return new Response(page, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
            "x-frame-options": "DENY",
          },
        });
      case "GET /api/state":
        return json(await this.deps.state());
      case "GET /api/history":
        return json(this.deps.history ? await this.deps.history() : {});
      case "GET /api/events":
        return this.events(req);
      case "POST /api/settings": {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "bad_json" }, 400);
        }
        if (typeof body !== "object" || body === null) return json({ error: "bad_json" }, 400);
        await this.deps.updateSettings(body as Record<string, unknown>);
        return json(await this.deps.state());
      }
      case "POST /api/code":
        this.deps.newCode();
        return json(await this.deps.state());
      case "POST /api/disconnect":
        this.deps.disconnect();
        return json(await this.deps.state());
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private events(req: Request): Response {
    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        let open = true;
        const ping = setInterval(() => client.send("ping", 0), 15000);
        client = {
          sendRaw(bytes) {
            if (!open) return;
            if ((ctrl.desiredSize ?? 0) < -MAX_CLIENT_QUEUE) return this.close();
            try {
              ctrl.enqueue(bytes);
            } catch {
              this.close();
            }
          },
          send(event, data) {
            this.sendRaw(frame(event, data));
          },
          close: () => {
            if (!open) return;
            open = false;
            clearInterval(ping);
            this.clients.delete(client);
            try {
              ctrl.close();
            } catch {}
          },
        };
        this.clients.add(client);
        req.signal.addEventListener("abort", () => client.close());
        Promise.resolve()
          .then(() => this.deps.state())
          .then((s) => client.send("state", s), () => {});
      },
      cancel: () => client?.close(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }
}
