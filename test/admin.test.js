import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createHealthServer } from "../src/server.js";
import { createAdminSession } from "../src/adminAuth.js";
import { buildOrderReadyEmail } from "../src/email.js";
import { createTestOrder, validateOrderStatus } from "../src/orders.js";
import { ValidationError } from "../src/validation.js";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3010,https://admin-bluemindwebservise.vercel.app",
  NODE_ENV: "development",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD_HASH: bcrypt.hashSync("correct-password", 10),
  ADMIN_SESSION_SECRET: "test-secret-with-at-least-thirty-two-characters",
};

async function withServer(run) {
  const server = createHealthServer(env);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("admin login validates credentials and creates an httpOnly session", async () => {
  await withServer(async base => {
    const denied = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://admin-bluemindwebservise.vercel.app" },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong" }),
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("set-cookie"), null);

    const accepted = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://admin-bluemindwebservise.vercel.app" },
      body: JSON.stringify({ email: "admin@example.com", password: "correct-password" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("access-control-allow-credentials"), "true");
    assert.match(accepted.headers.get("set-cookie") || "", /HttpOnly/);
  });
});

test("admin session and logout use the session cookie", async () => {
  await withServer(async base => {
    const token = createAdminSession(env);
    const session = await fetch(`${base}/api/admin/session`, {
      headers: { Cookie: `bluemind_admin_session=${encodeURIComponent(token)}` },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { success: true, authenticated: true });

    const logout = await fetch(`${base}/api/admin/logout`, { method: "POST" });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  });
});

test("admin order routes are protected before database access", async () => {
  await withServer(async base => {
    const orders = await fetch(`${base}/api/admin/orders`);
    assert.equal(orders.status, 401);
    assert.deepEqual(await orders.json(), { success: false, error: "Authentication required." });
  });
});

test("order status validation and ready email are shaped safely", () => {
  assert.equal(validateOrderStatus("Ready"), "Ready");
  assert.throws(() => validateOrderStatus("Unknown"), ValidationError);

  const order = createTestOrder();
  assert.equal(order.orderNumber, "#515");
  assert.equal(order.projectStatus, "New");

  const email = buildOrderReadyEmail(order);
  assert.equal(email.subject, "Your BlueMind Web Service order #515 is ready");
  assert.match(email.text, /Ahmed Example/);
  assert.match(email.text, /E-commerce Website/);
});
