import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  buildAdminLogoutCookie,
  buildAdminSessionCookie,
  createAdminSession,
  isAdminRequest,
  verifyAdminCredentials,
} from "./adminAuth.js";
import { getDatabase } from "./database.js";
import { sendFormNotification, sendOrderReadyNotification } from "./email.js";
import {
  buildOrderSearchQuery,
  ensureOrderIndexes,
  normalizeOrderNumber,
  serializeOrder,
  validateOrderStatus,
} from "./orders.js";
import { validateContactSubmission, validateQuoteSubmission, ValidationError } from "./validation.js";

const BODY_LIMIT_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const KNOWN_PRODUCTION_ORIGINS = [
  "https://bluemindwebservice.com",
  "https://www.bluemindwebservice.com",
  "https://bluemind-web-service.vercel.app",
  "https://admin-bluemindwebservise.vercel.app",
];

function parseAllowedOrigins(env) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!origins.length) throw new Error("ALLOWED_ORIGINS must be configured");
  const allowedOrigins = [...origins, ...KNOWN_PRODUCTION_ORIGINS];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid allowed origin");
    if (env.NODE_ENV === "production" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Production origins require HTTPS");
  }
  return new Set(allowedOrigins);
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
  for (const name of ["contacts", "quoteRequests", "clients", "projects", "orders", "adminEvents"]) {
    if (!existing.has(name)) await db.createCollection(name);
  }
  await ensureOrderIndexes(db);
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

async function handleAdminLogin(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const admin = await verifyAdminCredentials(env, body?.email, body?.password);
  if (!admin) return json(res, 401, { success: false, error: "Invalid email or password." });

  const token = createAdminSession(env, admin.employeeId);
  res.setHeader("Set-Cookie", buildAdminSessionCookie(token, env));
  return json(res, 200, { success: true, admin });
}

function handleAdminLogout(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  res.setHeader("Set-Cookie", buildAdminLogoutCookie(env));
  return json(res, 200, { success: true });
}

function requireAdmin(req, res, env) {
  const session = isAdminRequest(req, env);
  if (session) return session;
  json(res, 401, { success: false, error: "Authentication required." });
  return null;
}

async function listAdminOrders(req, res, env, url) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!requireAdmin(req, res, env)) return;

  const db = await getDatabase(env);
  await ensureCollections(db);
  const search = url.searchParams.get("search") || "";
  const orders = await db.collection("orders")
    .find(buildOrderSearchQuery(search))
    .sort({ createdAt: -1, orderNumber: -1 })
    .limit(100)
    .toArray();

  return json(res, 200, { success: true, orders: orders.map(serializeOrder) });
}

async function getAdminOrder(req, res, env, orderNumber) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!requireAdmin(req, res, env)) return;

  const db = await getDatabase(env);
  await ensureCollections(db);
  const order = await db.collection("orders").findOne({ orderNumber: normalizeOrderNumber(orderNumber) });
  if (!order) return json(res, 404, { success: false, error: "Order not found." });
  return json(res, 200, { success: true, order: serializeOrder(order) });
}

async function updateAdminOrderStatus(req, res, env, orderNumber) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const admin = requireAdmin(req, res, env);
  if (!admin) return;

  const body = await readJsonBody(req);
  const nextStatus = validateOrderStatus(body?.projectStatus);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const collection = db.collection("orders");
  const current = await collection.findOne({ orderNumber: normalizeOrderNumber(orderNumber) });
  if (!current) return json(res, 404, { success: false, error: "Order not found." });

  const updatedAt = new Date();
  const activity = {
    employeeId: admin.employeeId,
    action: `changed_status_to_${nextStatus.toLowerCase().replace(/\s+/g, "_")}`,
    message: `${admin.employeeId} changed Order ${current.orderNumber} status to ${nextStatus}`,
    createdAt: updatedAt,
  };
  await collection.updateOne(
    { _id: current._id },
    {
      $set: { projectStatus: nextStatus, updatedAt },
      $push: { activity },
    },
  );
  const updated = await collection.findOne({ _id: current._id });

  let notification = { sent: false, reason: "not_applicable" };
  if (current.projectStatus !== "Ready" && nextStatus === "Ready") {
    try {
      notification = await sendOrderReadyNotification(env, updated);
      await db.collection("adminEvents").insertOne({
        type: "order_ready",
        orderNumber: updated.orderNumber,
        employeeId: admin.employeeId,
        action: activity.action,
        message: activity.message,
        email: updated.email,
        notification,
        createdAt: new Date(),
      });
    } catch (error) {
      notification = { sent: false, reason: "failed" };
      console.error("Order ready notification failed", { orderNumber: updated.orderNumber, message: error?.message });
    }
  }

  return json(res, 200, { success: true, order: serializeOrder(updated), notification });
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
    const isAdminRoute = route.startsWith("/api/admin/");
    const adminOrderMatch = route.match(/^\/api\/admin\/orders\/([^/]+)$/);
    const allowedMethods = route === "/api/admin/orders" || adminOrderMatch
      ? "GET, PATCH, OPTIONS"
      : (isFormRoute || route === "/api/admin/login" || route === "/api/admin/logout" ? "POST, OPTIONS" : "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", allowedMethods);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (isAdminRoute) res.setHeader("Access-Control-Allow-Credentials", "true");
      res.writeHead(204);
      return res.end();
    }

    if (isAdminRoute) res.setHeader("Access-Control-Allow-Credentials", "true");

    try {
      if (route === "/api/health") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        return json(res, 200, { success: true, service: "BlueMind Web Service API", status: "healthy" });
      }

      if (route === "/api/admin/login") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleAdminLogin(req, res, env);
      }

      if (route === "/api/admin/logout") return handleAdminLogout(req, res, env);
      if (route === "/api/admin/session") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        const session = isAdminRequest(req, env);
        return json(res, 200, {
          success: true,
          authenticated: Boolean(session),
          admin: session ? { email: String(env.ADMIN_EMAIL || "").trim().toLowerCase(), employeeId: session.employeeId } : null,
        });
      }
      if (route === "/api/admin/orders") return await listAdminOrders(req, res, env, url);
      if (adminOrderMatch) {
        const orderNumber = decodeURIComponent(adminOrderMatch[1]);
        return req.method === "PATCH"
          ? await updateAdminOrderStatus(req, res, env, orderNumber)
          : await getAdminOrder(req, res, env, orderNumber);
      }

      if (!isFormRoute) return json(res, 404, { success: false, error: "Not found" });
      if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });

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
