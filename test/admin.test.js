import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createHealthServer } from "../src/server.js";
import { createAdminSession } from "../src/adminAuth.js";
import { buildBusinessPaymentEmail, buildCustomerPaymentEmail, buildCustomerReviewedEmail, buildOrderReadyEmail } from "../src/email.js";
import { createTestOrder, validateOrderStatus } from "../src/orders.js";
import { ValidationError } from "../src/validation.js";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3010,https://admin-bluemindwebservise.vercel.app",
  NODE_ENV: "development",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_M_PASSWORD_HASH: bcrypt.hashSync("m-password", 10),
  ADMIN_R_PASSWORD_HASH: bcrypt.hashSync("r-password", 10),
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

test("admin login validates two employee passwords and creates an httpOnly session", async () => {
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
      body: JSON.stringify({ email: "admin@example.com", password: "m-password" }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { success: true, admin: { email: "admin@example.com", employeeId: "M", displayName: "Mohmed" } });
    assert.equal(accepted.headers.get("access-control-allow-credentials"), "true");
    assert.match(accepted.headers.get("set-cookie") || "", /HttpOnly/);

    const second = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://admin-bluemindwebservise.vercel.app" },
      body: JSON.stringify({ email: "admin@example.com", password: "r-password" }),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { success: true, admin: { email: "admin@example.com", employeeId: "R", displayName: "Rokaia" } });
  });
});

test("admin session and logout use the session cookie", async () => {
  await withServer(async base => {
    const token = createAdminSession(env, "R");
    const session = await fetch(`${base}/api/admin/session`, {
      headers: { Cookie: `bluemind_admin_session=${encodeURIComponent(token)}` },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      success: true,
      authenticated: true,
      admin: { email: "admin@example.com", employeeId: "R", displayName: "Rokaia" },
      employee: { email: "admin@example.com", employeeId: "R", displayName: "Rokaia" },
    });

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
  assert.equal(validateOrderStatus("Pending Review"), "Pending Review");
  assert.equal(validateOrderStatus("Awaiting Clarification"), "Awaiting Clarification");
  assert.equal(validateOrderStatus("Confirmed"), "Confirmed");
  assert.throws(() => validateOrderStatus("Unknown"), ValidationError);

  const order = createTestOrder();
  assert.equal(order.orderNumber, "#515");
  assert.equal(order.projectStatus, "New");

  const email = buildOrderReadyEmail(order);
  assert.equal(email.subject, "Your BlueMind Web Service order #515 is ready");
  assert.match(email.text, /Ahmed Example/);
  assert.match(email.text, /E-commerce Website/);
});

test("paid order email copy separates payment confirmation from employee review confirmation", () => {
  const order = createTestOrder();
  const paidOrder = {
    ...order,
    orderNumber: "#516",
    isPaidOrder: true,
    paymentMode: "live",
    stripeLivemode: true,
    projectStatus: "Pending Review",
    paymentOption: "deposit",
    totalAmountOre: 749000,
    amountPaidOre: 374500,
    remainingBalanceOre: 374500,
    packageName: "Business Website",
    requestedFeatures: ["Contact Form", "Gallery"],
    createdAt: new Date("2026-10-08T10:00:00.000Z"),
  };

  const customer = buildCustomerPaymentEmail(paidOrder);
  assert.match(customer.subject, /Payment Received/);
  assert.match(customer.text, /team will review your requirements/);
  assert.doesNotMatch(customer.text, /has now been confirmed by our team/);

  const business = buildBusinessPaymentEmail(paidOrder, { ADMIN_FRONTEND_URL: "https://admin.example.com" });
  assert.match(business.subject, /New Paid Website Order/);
  assert.match(business.text, /Pending Review/);
  assert.match(business.text, /https:\/\/admin\.example\.com/);

  const reviewed = buildCustomerReviewedEmail(paidOrder);
  assert.match(reviewed.subject, /Your Project Is Confirmed/);
  assert.match(reviewed.text, /has now been confirmed by our team/);
});

test("sandbox test order email copy is marked as test mode", () => {
  const testOrder = {
    ...createTestOrder(),
    orderNumber: "#600",
    packageId: "bluemind-test-package",
    packageName: "BlueMind Test Package",
    package: "BlueMind Test Package",
    customerName: "Test Customer",
    email: "test.customer@example.com",
    isPaidOrder: true,
    isSandboxTestOrder: true,
    testMode: "stripe_sandbox",
    totalAmountOre: 1000,
    amountPaidOre: 1000,
    remainingBalanceOre: 0,
    paymentStatus: "Test Paid",
    projectStatus: "Pending Review",
  };

  const customer = buildCustomerPaymentEmail(testOrder);
  assert.equal(customer.subject, "BlueMind - Sandbox Test Payment Confirmed");
  assert.match(customer.text, /Sandbox Test Only/);
  assert.match(customer.text, /not a real paid customer order/);
  assert.match(customer.text, /10 SEK/);

  const business = buildBusinessPaymentEmail(testOrder, { ADMIN_FRONTEND_URL: "https://admin.example.com" });
  assert.equal(business.subject, "BlueMind - New Sandbox Test Order Received");
  assert.match(business.text, /NEW SANDBOX TEST ORDER RECEIVED/);
  assert.match(business.text, /do not count as real customer revenue/);
});

test("admin presence routes are protected before database access", async () => {
  await withServer(async base => {
    const presence = await fetch(`${base}/api/admin/presence`);
    assert.equal(presence.status, 401);

    const heartbeat = await fetch(`${base}/api/admin/presence/heartbeat`, { method: "POST" });
    assert.equal(heartbeat.status, 401);
  });
});
