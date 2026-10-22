import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/server.js";

test("customer chat needs no credentials and does not unlock Workspace APIs", async () => {
  const origin = "https://bluemind-web-service.vercel.app";
  const env = { NODE_ENV: "test", AI_ENABLED: "true", AI_ALLOWED_ORIGINS: origin, ALLOWED_ORIGINS: origin, OPENAI_API_KEY: "fixture-only" };
  let calls = 0;
  const server = createHealthServer(env, { ai: { log: () => {}, provider: async () => (async function* () { calls++; yield { type: "delta", text: "Test fixture" }; yield { type: "done", inputTokens: 1, outputTokens: 1 }; })() } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/ai/chat`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Help me choose a website package" }] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"done"/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/api/ai/session`, { headers: { Origin: origin } })).status, 404);
    for (const path of ["/api/admin/orders", "/api/employee/tools", "/api/workspace/messenger/contacts"]) {
      assert.equal((await fetch(base + path, { headers: { Origin: origin } })).status, 401);
    }
    const session = await (await fetch(`${base}/api/admin/session`, { headers: { Origin: origin } })).json();
    assert.equal(session.authenticated, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
