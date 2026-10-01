import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/server.js";
test("health, CORS, methods, and unknown routes", async () => {
  const server = createHealthServer({ ALLOWED_ORIGINS: "http://localhost:3000,https://frontend.example.com", NODE_ENV: "production" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { success: true, service: "BlueMind Web Service API", status: "healthy" });
    for (const origin of ["http://localhost:3000", "https://frontend.example.com"]) {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
    const denied = await fetch(`${base}/api/health`, { headers: { Origin: "https://untrusted.example.com" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${base}/api/health`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { success: false, error: "Not found" });
    assert.equal((await fetch(`${base}/api/health`, { method: "POST" })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("reject unsafe CORS configuration", () => {
  for (const origin of ["", "*", "https://example.com/path", "http://example.com"]) {
    assert.throws(() => createHealthServer({ ALLOWED_ORIGINS: origin, NODE_ENV: "production" }));
  }
});
