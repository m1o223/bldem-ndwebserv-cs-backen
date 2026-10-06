import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getDatabase } from "./database.js";
import { sendFormNotification } from "./email.js";
import { validateContactSubmission, validateQuoteSubmission, ValidationError } from "./validation.js";

const BODY_LIMIT_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

function parseAllowedOrigins(env) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!origins.length) throw new Error("ALLOWED_ORIGINS must be configured");
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid allowed origin");
    if (env.NODE_ENV === "production" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Production origins require HTTPS");
  }
  return new Set(origins);
}

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function createRateLimiter() {
  const buckets = new Map();
  return req => {
    const now = Date.now();
    const key = getClientKey(req);
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    current.count += 1;
    return current.count <= RATE_LIMIT_MAX;
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

async function ensureCollections(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name));
  for (const name of ["contacts", "quoteRequests", "clients", "projects"]) {
    if (!existing.has(name)) await db.createCollection(name);
  }
}

async function handleFormRoute(req, res, env, route) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const collectionName = route === "/api/contact" ? "contacts" : "quoteRequests";
  const doc = route === "/api/contact" ? validateContactSubmission(body) : validateQuoteSubmission(body);
  const db = await getDatabase(env);
  await ensureCollections(db);
  await db.collection(collectionName).insertOne(doc);
  try {
    await sendFormNotification(env, route, doc);
  } catch (error) {
    console.error("Email notification failed", { route, message: error?.message });
  }

  return json(res, 200, {
    success: true,
    message: route === "/api/contact" ? "Message received successfully" : "Quote request received successfully"
  });
}

export function createHealthServer(env = process.env) {
  const allowed = parseAllowedOrigins(env);
  const checkRateLimit = createRateLimiter();

  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    res.setHeader("Referrer-Policy", "no-referrer");

    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return json(res, 403, { success: false, error: "Origin not allowed" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname;
    const isFormRoute = route === "/api/contact" || route === "/api/quote";
    const allowedMethods = isFormRoute ? "POST, OPTIONS" : "GET, OPTIONS";

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", allowedMethods);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      return res.end();
    }

    if (route === "/api/health") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return json(res, 405, { success: false, error: "Method not allowed" });
      }
      return json(res, 200, { success: true, service: "BlueMind Web Service API", status: "healthy" });
    }

    if (!isFormRoute) return json(res, 404, { success: false, error: "Not found" });
    if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });

    try {
      return await handleFormRoute(req, res, env, route);
    } catch (error) {
      if (error instanceof ValidationError) return json(res, 400, { success: false, error: "Please check the form and try again.", fields: error.fields });
      if (error?.statusCode) return json(res, error.statusCode, { success: false, error: error.message });
      console.error("Request failed", { route, message: error?.message });
      return json(res, 500, { success: false, error: "Something went wrong. Please try again later." });
    }
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
