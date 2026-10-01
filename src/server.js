import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
export function createHealthServer(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!origins.length) throw new Error("ALLOWED_ORIGINS must be configured");
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid allowed origin");
    if (env.NODE_ENV === "production" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Production origins require HTTPS");
  }
  const allowed = new Set(origins);
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return send(403, { success: false, error: "Origin not allowed" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.url !== "/api/health") return send(404, { success: false, error: "Not found" });
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.writeHead(204); return res.end();
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return send(405, { success: false, error: "Method not allowed" });
    }
    return send(200, { success: true, service: "BlueMind Web Service API", status: "healthy" });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const server = createHealthServer();
  server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`BlueMind API listening on port ${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
