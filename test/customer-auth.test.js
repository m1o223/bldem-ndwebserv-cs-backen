import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import bcrypt from "bcryptjs";
import { createCustomerAuth, createCustomerRoute, CUSTOMER_SESSION_SECONDS, provisionInitialCustomer } from "../src/customerAuth.js";
import { memoryDatabase } from "./fixtures/customer-memory.mjs";

const password = "Isolated-test-only-123!";
const passwordHash = await bcrypt.hash(password, 12);
test("manual initial account provisioning is idempotent and never resets existing credentials", async () => {
  const db = memoryDatabase();
  const env = { CUSTOMER_INITIAL_EMAIL: "new@example.invalid", CUSTOMER_INITIAL_PASSWORD_HASH: passwordHash };
  await provisionInitialCustomer(db, env);
  await provisionInitialCustomer(db, { ...env, CUSTOMER_INITIAL_PASSWORD_HASH: await bcrypt.hash("other-password-123!", 12) });
  assert.equal(db.collections.get("customerAccounts").length, 1);
  assert.equal(db.collections.get("customerAccounts")[0].passwordHash, passwordHash);
  await assert.rejects(() => provisionInitialCustomer(db, { CUSTOMER_INITIAL_EMAIL: "x" }));
  await provisionInitialCustomer(db, {});
});
async function setup() {
  const db = memoryDatabase();
  await db.collection("customerAccounts").insertOne({ _id: "test-user", email: "customer@example.invalid", displayName: "Test customer", enabled: true, passwordHash });
  let now = Date.now();
  return { db, auth: createCustomerAuth({ database: async () => db, now: () => now }), advance(ms) { now += ms; } };
}
test("real bcrypt credentials issue opaque hashed sessions, expire and revoke", async () => {
  const { auth, db, advance } = await setup();
  const login = await auth.login({ email: "CUSTOMER@example.invalid", password });
  assert.equal(login.status, 200);
  assert.equal(login.token.length, 64);
  assert.equal(JSON.stringify(db.collections.get("customerSessions")).includes(login.token), false);
  assert.equal((await auth.session(login.token)).id, "test-user");
  assert.equal("passwordHash" in login.user, false);
  const second = await auth.login({ email: "customer@example.invalid", password }, login.token);
  assert.equal(await auth.session(login.token), null);
  await auth.logout(second.token);
  assert.equal(await auth.session(second.token), null);
  const third = await auth.login({ email: "customer@example.invalid", password });
  advance(CUSTOMER_SESSION_SECONDS * 1000 + 1);
  assert.equal(await auth.session(third.token), null);
});
test("invalid credentials, disabled accounts and workspace tokens cannot enter", async () => {
  const { auth, db } = await setup();
  assert.equal((await auth.login({ email: {}, password })).status, 400);
  assert.equal((await auth.login({ email: "customer@example.invalid", password: "x".repeat(73) })).status, 400);
  assert.equal((await auth.login({ email: "customer@example.invalid", password: "wrong" })).code, "credentials");
  assert.equal((await auth.login({ email: "missing@example.invalid", password })).code, "credentials");
  assert.equal(await auth.session("workspace.payload.signature"), null);
  db.collections.get("customerAccounts")[0].enabled = false;
  assert.equal((await auth.login({ email: "customer@example.invalid", password })).code, "credentials");
});
test("account rate limiting is persistent across handler instances", async () => {
  const { auth, db } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await auth.login({ email: "customer@example.invalid", password: "wrong" })).status, 401);
  const another = createCustomerAuth({ database: async () => db });
  assert.equal((await another.login({ email: "customer@example.invalid", password })).status, 429);
});
test("database failure fails closed", async () => {
  const auth = createCustomerAuth({ database: async () => { throw new Error("private database info"); } });
  await assert.rejects(() => auth.session("a".repeat(64)));
  assert.equal(await auth.session("invalid"), null);
});
test("HTTP routes reject unapproved origins, wrong methods, oversized input and sanitize failures", async t => {
  const route = createCustomerRoute({ NODE_ENV: "production" }, { database: async () => { throw new Error("private database info"); } });
  const server = createServer((req, res) => route(req, res, new URL(req.url, "http://localhost").pathname));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port;
  const origin = { Origin: "https://bluemind-web-service.vercel.app" };
  assert.equal((await fetch(url + "/api/customer/session")).status, 403);
  assert.equal((await fetch(url + "/api/customer/login", { headers: origin })).status, 405);
  const large = await fetch(url + "/api/customer/login", { method: "POST", headers: { ...origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "x".repeat(3000) }) });
  assert.equal(large.status, 400);
  const failed = await fetch(url + "/api/customer/session", { headers: { ...origin, Authorization: "Bearer " + "a".repeat(64) } });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { code: "unavailable" });
  assert.equal(failed.headers.get("cache-control"), "no-store");
});
