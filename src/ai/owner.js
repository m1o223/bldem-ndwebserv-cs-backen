import { createHash, randomBytes } from "node:crypto";
import { verifyAdminCredentials } from "../adminAuth.js";
import { createChatHandler } from "./server.js";

const TTL = 30 * 60 * 1000;
const digest = value => createHash("sha256").update(value).digest("hex");
const reply = (status, code) => Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });

// AI-only opaque sessions never authorize workspace, customer, or payment APIs.
// Restarting the service revokes all test sessions. No database writes are needed.
export function createOwnerHandler(env, options = {}) {
  const sessions = new Map();
  const now = options.now ?? Date.now;
  const chat = createChatHandler({ ...options, env: { ...env, AI_ENABLED: "true" } });
  let attempts = 0;
  let reset = 0;
  let signingIn = false;
  return async (request, peer) => {
    if (env.AI_OWNER_TEST_ENABLED !== "true") return reply(503, "unavailable");
    const time = now();
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
    const authorization = request.headers.get("authorization") || "";
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    const key = token ? digest(token) : "";
    const authenticated = sessions.has(key);
    const sessionRoute = new URL(request.url).pathname === "/api/ai/session";
    if (!sessionRoute) {
      if (!authenticated) return reply(401, "unauthorized");
      return chat(request, peer);
    }
    if (request.method === "DELETE") {
      sessions.delete(key);
      return reply(200, "signed_out");
    }
    if (request.method === "GET") return reply(authenticated ? 200 : 401, authenticated ? "authenticated" : "unauthorized");
    if (request.method !== "POST") return reply(405, "invalid");
    if (time >= reset) { attempts = 0; reset = time + 60000; }
    // A strict instance-wide login quota cannot be bypassed with forwarding headers.
    if (attempts >= 5 || signingIn) return reply(429, "rate");
    attempts++;
    signingIn = true;
    try {
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 2048) return reply(413, "invalid");
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, "invalid"); }
      if (!body || Object.keys(body).sort().join(",") !== "email,password" ||
        typeof body.email !== "string" || body.email.length > 254 ||
        typeof body.password !== "string" || !body.password || body.password.length > 128) return reply(400, "invalid");
      const identity = await verifyAdminCredentials(env, body.email, body.password);
      if (!identity || identity.access !== "admin" || identity.employeeId !== "M") return reply(401, "unauthorized");
      const sessionToken = randomBytes(32).toString("base64url");
      if (sessions.size >= 4) sessions.delete(sessions.keys().next().value);
      sessions.set(digest(sessionToken), time + TTL);
      return Response.json({ token: sessionToken, expiresIn: TTL / 1000 }, { headers: { "Cache-Control": "no-store" } });
    } catch { return reply(503, "unavailable"); }
    finally { signingIn = false; }
  };
}
