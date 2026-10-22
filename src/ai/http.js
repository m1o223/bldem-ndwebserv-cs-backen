import { once } from "node:events";
import { AI_LIMITS } from "./contract.js";
import { allowedAiOrigins } from "./config.js";
import { createChatHandler } from "./server.js";

function readIncomingBody(req, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) { req.pause(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > AI_LIMITS.bodyBytes) finish(Object.assign(new Error("body limit"), { status: 413 }));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error("body failed"));
    const onAbort = () => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(Object.assign(new Error("body timeout"), { status: 408 })), timeoutMs);
    req.on("data", onData); req.once("end", onEnd); req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

// This adapter is the only integration point with the existing Node HTTP server.
export function createAiRoute(env, options = {}) {
  const handle = createChatHandler({ ...options, env });
  const allowed = allowedAiOrigins(env);
  let receiving = 0;
  return async (req, res) => {
    const reject = (status, code) => {
      if (res.destroyed) return;
      res.statusCode = status;
      if (status === 429) res.setHeader("Retry-After", "60");
      res.end(JSON.stringify({ code }));
    };
    if (!allowed) return reject(503, "unavailable");
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return reject(403, "invalid");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
    if (req.method === "OPTIONS") {
      const headers = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
      if (req.headers["access-control-request-method"] !== "POST" || headers.some(header => header !== "content-type")) return reject(403, "invalid");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return reject(405, "invalid"); }
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return reject(415, "invalid");
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return reject(415, "invalid");
    if (Number(req.headers["content-length"]) > AI_LIMITS.bodyBytes) {
      res.setHeader("Connection", "close");
      return reject(413, "invalid");
    }
    if (receiving >= 8) return reject(429, "rate");
    receiving++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    let reader;
    try {
      let body;
      try { body = await readIncomingBody(req, controller.signal, options.bodyTimeoutMs ?? 5000); }
      catch (error) {
        if (!res.destroyed) res.setHeader("Connection", "close");
        return reject(error.status === 413 ? 413 : error.status === 408 ? 408 : 400, "invalid");
      }
      const request = new Request("http://backend.internal/api/ai/chat", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body, signal: controller.signal,
      });
      const response = await handle(request, req.socket.remoteAddress || "unknown");
      if (res.destroyed) { await response.body?.cancel(); return; }
      res.statusCode = response.status;
      for (const [name, value] of response.headers) res.setHeader(name, value);
      res.flushHeaders();
      reader = response.body?.getReader();
      // Abort the Web stream as well as the SDK when the browser disconnects.
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (reader && !controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
        }
        if (!res.destroyed) res.end();
      } finally { controller.signal.removeEventListener("abort", cancel); }
    } catch {
      if (!res.headersSent) reject(502, "failed");
      else if (!res.destroyed) res.end();
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      receiving--;
      req.off("aborted", abort); res.off("close", abort);
      abort();
    }
  };
}
