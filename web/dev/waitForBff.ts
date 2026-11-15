import net from "node:net";

/** True once something accepts TCP on 127.0.0.1:port. */
const isUp = (port: number) => new Promise<boolean>((ok) => {
  const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); ok(true); }); s.once("error", () => ok(false));
});

/**
 * Dev-only middleware placed before the /api proxy. On restart Vite is ready in under a second but the bff
 * takes a few seconds to listen, and Vite's proxy turns ECONNREFUSED into a 500. This holds /api requests
 * until the bff port opens (checked on every request, so tsx watch restarts are covered too), and answers 503 with Retry-After if it never does.
 */
export function waitForBff(port: number, timeoutMs = 20000) {
  return async (req: { url?: string }, res: any, next: () => void) => {
    if (!req.url?.startsWith("/api")) return next();
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await isUp(port)) return next();
      await new Promise((r) => setTimeout(r, 150));
    }
    res.statusCode = 503; res.setHeader("Retry-After", "1"); res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Server is starting, try again in a moment" }));
  };
}
