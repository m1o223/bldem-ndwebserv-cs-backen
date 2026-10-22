import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createOwnerHandler } from "../src/ai/owner.js";
import { createAdminSession, verifyWorkspaceSession } from "../src/adminAuth.js";

const origin = "https://bluemind-web-service.vercel.app";
const env = { NODE_ENV: "test", AI_OWNER_TEST_ENABLED: "true", AI_ENABLED: "false", AI_ALLOWED_ORIGINS: origin, OPENAI_API_KEY: "fixture", ADMIN_EMAIL: "owner@example.test", ADMIN_M_PASSWORD_HASH: bcrypt.hashSync("owner-fixture", 4), ADMIN_R_PASSWORD_HASH: bcrypt.hashSync("other-admin-fixture", 4), WORKSPACE_AHMED_PASSWORD_HASH: bcrypt.hashSync("employee-fixture", 4), ADMIN_SESSION_SECRET: "fixture-only-signing-secret-with-32-characters" };
function request(path, method = "GET", body, token) {
  return new Request(`https://backend.test/api/ai/${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const login = (handler, email = env.ADMIN_EMAIL, password = "owner-fixture") => handler(request("session", "POST", { email, password }));

test("only verified owner credentials create an AI-scoped session", async () => {
  const handle = createOwnerHandler(env);
  for (const [email, password] of [[env.ADMIN_EMAIL, "wrong"], [env.ADMIN_EMAIL, "other-admin-fixture"], ["ahmed@bluemind.com", "employee-fixture"]]) {
    assert.equal((await login(handle, email, password)).status, 401);
  }
  const response = await login(handle);
  assert.equal(response.status, 200);
  const { token, expiresIn } = await response.json();
  assert.equal(expiresIn, 1800);
  assert.equal(verifyWorkspaceSession(token, env), false);
  assert.equal((await handle(request("session", "GET", undefined, token))).status, 200);
  assert.equal((await handle(request("session", "GET", undefined, `${token}x`))).status, 401);
});

test("public access and all ordinary workspace tokens cannot execute AI", async () => {
  let calls = 0;
  const handle = createOwnerHandler({ ...env, AI_ENABLED: "true" }, { provider: () => { calls++; } });
  for (const token of [undefined, "forged", createAdminSession(env, "M"), createAdminSession(env, "R")]) {
    assert.equal((await handle(request("chat", "POST", { messages: [{ role: "user", content: "hello" }] }, token))).status, 401);
  }
  assert.equal(calls, 0);
});

test("owner execution works while public AI is disabled; logout revokes access", async () => {
  let calls = 0;
  const handle = createOwnerHandler(env, { log: () => {}, provider: async () => (async function* () { calls++; yield { type: "delta", text: "fixture" }; yield { type: "done", inputTokens: 1, outputTokens: 1 }; })() });
  const { token } = await (await login(handle)).json();
  const response = await handle(request("chat", "POST", { messages: [{ role: "user", content: "hello" }] }, token));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"done"/);
  assert.equal(calls, 1);
  await handle(request("session", "DELETE", undefined, token));
  assert.equal((await handle(request("chat", "POST", { messages: [] }, token))).status, 401);
});

test("sessions expire, restart revokes them, and kill switch fails closed", async () => {
  let time = Date.now();
  const handle = createOwnerHandler(env, { now: () => time });
  const { token } = await (await login(handle)).json();
  assert.equal((await createOwnerHandler(env)(request("session", "GET", undefined, token))).status, 401);
  time += 1800001;
  assert.equal((await handle(request("session", "GET", undefined, token))).status, 401);
  for (const flag of [undefined, "false", "TRUE"]) assert.equal((await createOwnerHandler({ ...env, AI_OWNER_TEST_ENABLED: flag })(request("session"))).status, 503);
});

test("login quotas, validation and session limits fail safely", async () => {
  const handle = createOwnerHandler(env);
  assert.equal((await handle(request("session", "POST", { email: env.ADMIN_EMAIL, password: "owner-fixture", role: "admin" }))).status, 400);
  for (let i = 0; i < 4; i++) await login(handle, env.ADMIN_EMAIL, "wrong");
  assert.equal((await login(handle)).status, 429);
  const bounded = createOwnerHandler(env);
  const tokens = [];
  for (let i = 0; i < 5; i++) tokens.push((await (await login(bounded)).json()).token);
  assert.equal((await bounded(request("session", "GET", undefined, tokens[0]))).status, 401);
  assert.equal((await bounded(request("session", "GET", undefined, tokens[4]))).status, 200);
});
