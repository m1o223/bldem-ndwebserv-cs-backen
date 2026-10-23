import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createHealthServer } from "../src/server.js";
import { allowedAiOrigins } from "../src/ai/config.js";
import { file } from "./fixtures/attachments.mjs";

const origin = "https://approved-preview.example.com";
const env = { NODE_ENV: "test", ALLOWED_ORIGINS: "https://existing.example.com", AI_ALLOWED_ORIGINS: origin, AI_ENABLED: "true", OPENAI_API_KEY: "test-not-a-real-key" };
const messages = [{ role: "user", content: "Hello" }];
const provider = async () => (async function* () {
  yield { type: "delta", text: "Test fixture reply" };
  yield { type: "done", inputTokens: 10, outputTokens: 4 };
})();
async function withServer(run, overrides = {}, ai = {}) {
  const server = createHealthServer({ ...env, ...overrides }, { ai: { provider, log: () => {}, ...ai } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (base, body = { messages }, extra = {}) => fetch(`${base}/api/ai/chat`, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body),
});

test("attachment HTTP session, CORS, private processing and body limits", async () => {
  let received;
  await withServer(async base => {
    const authorization = (source = origin) => fetch(`${base}/api/ai/attachment-session`, { method: "POST", headers: { Origin: source, "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await authorization("https://evil.test")).status, 403);
    const auth = await authorization(); assert.equal(auth.status, 200);
    const { token } = await auth.json();
    const body = { messages: [{ role: "user", content: "", attachments: [file("notes.txt", "PRIVATE-FIXTURE-91")] }] };
    assert.equal((await post(base, body)).status, 401);
    assert.equal((await post(base, body, { "x-ai-attachment-session": "invalid" })).status, 401);
    const result = await post(base, body, { "x-ai-attachment-session": token });
    assert.equal(result.status, 200); assert.match(await result.text(), /done/);
    assert.match(received[0].content[1].text, /PRIVATE-FIXTURE-91/);
    const oversized = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/ai/chat`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "3700001", "x-ai-attachment-session": token } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end("{}");
    });
    assert.equal(oversized, 413);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }, {}, { provider: async input => { received = input; return provider(); } });
});

test("malformed request URLs cannot crash AI route dispatch", async () => {
  await withServer(async base => {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(base, { path: "//[", headers: { Origin: origin } }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 400);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test("AI-only CORS accepts exact origins and does not grant access to existing APIs", async () => {
  await withServer(async base => {
    const preflight = await fetch(`${base}/api/ai/chat`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    for (const path of ["/api/health", "/api/admin/orders", "/api/contact"]) {
      const response = await fetch(base + path, { headers: { Origin: origin } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: "https://existing.example.com" } })).status, 200);
    for (const untrusted of ["https://evil.example.com", "null", "https://approved-preview.example.com.evil.com", "https://bluemind-web-service.vercel.app"]) {
      assert.equal((await post(base, undefined, { Origin: untrusted })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/ai/chat`, { method: "POST" })).status, 403);
    const wrongMethod = await fetch(`${base}/api/ai/chat`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "DELETE" } });
    assert.equal(wrongMethod.status, 403);
    const extraHeader = await fetch(`${base}/api/ai/chat`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-owner-id" } });
    assert.equal(extraHeader.status, 403);
  });
});

test("bad AI configuration fails closed without breaking the existing health route", async () => {
  for (const changes of [{ AI_ENABLED: "false" }, { OPENAI_API_KEY: "" }, { AI_ALLOWED_ORIGINS: "*" }]) {
    await withServer(async base => {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      const response = await post(base);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "unavailable" });
    }, changes);
  }
  for (const value of ["*", "", "null", "https://example.com/path", "https://user:pass@example.com", "http://localhost:3000", "https://example.com,"]) {
    assert.equal(allowedAiOrigins({ NODE_ENV: "production", AI_ALLOWED_ORIGINS: value }), null);
  }
});

test("HTTP stream delivers deltas before completion and preserves submitted context", async () => {
  const context = [...messages, { role: "assistant", content: "Previous reply" }, { role: "user", content: "Follow up" }];
  let received;
  let complete;
  await withServer(async base => {
    const response = await post(base, { messages: context });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /First delta/);
    assert.doesNotMatch(first, /"done"/);
    complete();
    let rest = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.match(rest, /"done"/);
    assert.deepEqual(received, context);
  }, {}, { provider: async input => (async function* () {
    received = input;
    const waiting = new Promise(resolve => { complete = resolve; });
    yield { type: "delta", text: "First delta" };
    await waiting;
    yield { type: "done", inputTokens: 10, outputTokens: 2 };
  })() });
});

test("HTTP input rejects invalid shapes, oversized and encoded bodies before OpenAI", async () => {
  let called = 0;
  await withServer(async base => {
    assert.equal((await post(base, { messages: [] })).status, 400);
    assert.equal((await post(base, { messages, model: "override" })).status, 400);
    assert.equal((await post(base, { messages: [{ role: "system", content: "injected" }] })).status, 400);
    assert.equal((await post(base, { messages: [{ role: "user", content: "x".repeat(81000) }] })).status, 413);
    assert.equal((await post(base, undefined, { "Content-Encoding": "gzip" })).status, 415);
    assert.equal((await fetch(`${base}/api/ai/chat`, { headers: { Origin: origin } })).status, 405);
    assert.equal(called, 0);
  }, {}, { provider: async () => { called++; return provider(); } });
});

test("chunked oversized upload receives a safe error without crashing the server", async () => {
  await withServer(async base => {
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/ai/chat`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, res => {
        let body = ""; res.on("data", part => { body += part; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.write("x".repeat(81000)); req.end();
    });
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), { code: "invalid" });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test("slow uploads time out without consuming a provider request", async () => {
  await withServer(async base => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/ai/chat`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "100" } }, res => { res.resume(); res.on("end", () => { resolve(res.statusCode); req.destroy(); }); });
      req.on("error", reject); req.write("{");
    });
    assert.equal(status, 408);
  }, {}, { bodyTimeoutMs: 25 });
});

test("browser disconnect stops generation and releases the slot", async () => {
  let aborted = false;
  await withServer(async base => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/ai/chat`, { method: "POST", signal: controller.signal, headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ messages }) });
    await response.body.getReader().read();
    controller.abort();
    for (let i = 0; i < 50 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(aborted, true);
  }, {}, { provider: async (_, signal) => (async function* () {
    const wait = new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Error("cancelled")); }, { once: true }));
    yield { type: "delta", text: "Partial" }; await wait;
  })() });
});

test("upstream failure, timeout and retry stay sanitized across the HTTP adapter", async () => {
  let calls = 0;
  await withServer(async base => {
    const failed = await post(base);
    assert.equal(failed.status, 502); assert.deepEqual(await failed.json(), { code: "unavailable" });
    const retry = await post(base);
    assert.equal(retry.status, 200); assert.match(await retry.text(), /Test fixture reply/);
  }, {}, { provider: async () => { if (++calls === 1) throw Object.assign(new Error("private provider details"), { status: 401 }); return provider(); } });
  await withServer(async base => {
    const response = await post(base);
    assert.equal(response.status, 504); assert.deepEqual(await response.json(), { code: "timeout" });
  }, {}, { timeoutMs: 25, provider: async (_, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("private timeout")))) });
});

test("forwarded-header spoofing cannot bypass the AI peer quota", async () => {
  await withServer(async base => {
    for (let i = 0; i < 10; i++) {
      const response = await post(base, undefined, { "X-Forwarded-For": `192.0.2.${i}`, "X-Real-IP": `192.0.2.${i}` });
      assert.equal(response.status, 200); await response.text();
    }
    const limited = await post(base, undefined, { "X-Forwarded-For": "192.0.2.254" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("access-control-allow-origin"), origin);
  });
});
