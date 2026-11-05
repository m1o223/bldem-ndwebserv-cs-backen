import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";
import { createCustomerAuth, createCustomerRoute } from "../src/customerAuth.js";
import { GOOGLE_CALLBACK_URL } from "../src/customerGoogle.js";
import { memoryDatabase } from "./fixtures/customer-memory.mjs";
import { createServer } from "node:http";

const env = { GOOGLE_AUTH_ENABLED: "true", GOOGLE_CLIENT_ID: "isolated-test-client", GOOGLE_CLIENT_SECRET: "test-only-not-a-secret", GOOGLE_REDIRECT_URI: GOOGLE_CALLBACK_URL };
function setup(overrides = {}) {
  const db = memoryDatabase();
  let time = Date.now(), calls = 0, nonce, tokenOptions;
  const googleClientFactory = options => {
    const client = new OAuth2Client(options);
    client.getToken = async options => { calls++; tokenOptions = options; if (overrides.fail) throw new Error("private provider details"); return { tokens: { id_token: "test-token" } }; };
    client.verifyIdToken = async options => {
      assert.equal(options.audience, env.GOOGLE_CLIENT_ID);
      if (overrides.signatureFailure) throw new Error("signature rejected");
      return { getPayload: () => ({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "google-subject-one", email: "google@example.invalid", email_verified: true, name: "Test Google customer", nonce, ...overrides.claims }) };
    };
    return client;
  };
  const auth = createCustomerAuth({ env: { ...env, ...overrides.env }, database: async () => db, now: () => time, googleClientFactory });
  return { db, auth, calls: () => calls, tokenOptions: () => tokenOptions, advance: ms => { time += ms; }, async start(body = {}) {
    const result = await auth.google("google-start", body);
    const url = new URL(result.authorizationUrl);
    nonce = url.searchParams.get("nonce");
    return { result, url, body: { state: url.searchParams.get("state"), browserToken: result.browserToken, code: "test-code" } };
  } };
}

test("Google authorization uses exact production callback, PKCE, state, nonce and minimal scopes", async () => {
  const s = setup(), { result, url } = await s.start({ customerType: "company" });
  assert.equal(result.status, 200);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), GOOGLE_CALLBACK_URL);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.match(url.searchParams.get("nonce"), /^[a-f0-9]{64}$/);
  const stored = s.db.collections.get("customerGoogleFlows")[0];
  assert.ok(stored.codeVerifier.length >= 43);
  assert.equal(stored.customerType, "company");
  assert.equal(JSON.stringify(stored).includes(result.browserToken), false);
  assert.equal(url.toString().includes(env.GOOGLE_CLIENT_SECRET), false);
});

test("successful verified Google identity creates a customer session and returns to the same account", async () => {
  const s = setup(), first = await s.start();
  const login = await s.auth.google("google-callback", first.body);
  assert.equal(login.status, 200);
  assert.equal((await s.auth.session(login.token)).id, login.user.id);
  assert.equal(s.tokenOptions().redirect_uri, GOOGLE_CALLBACK_URL);
  assert.ok(s.tokenOptions().codeVerifier);
  assert.equal("googleSubject" in login.user, false);
  const account = s.db.collections.get("customerAccounts")[0];
  assert.equal(account.customerType, null);
  assert.equal("passwordHash" in account, false);
  const next = await s.start({ customerType: "private" });
  const second = await s.auth.google("google-callback", next.body, login.token);
  assert.equal(second.user.id, login.user.id);
  assert.equal(s.db.collections.get("customerAccounts").length, 1);
  assert.equal(await s.auth.session(login.token), null);
  assert.deepEqual((await s.auth.workspace("overview", second.token)).profile.loginMethods, ["google"]);
  await s.auth.logout(second.token);
  assert.equal(await s.auth.session(second.token), null);
});

test("invalid browser binding, expired flows, replay and concurrent callbacks fail closed", async () => {
  const s = setup(), { body } = await s.start();
  assert.equal((await s.auth.google("google-callback", { ...body, browserToken: "a".repeat(64) })).status, 400);
  assert.equal(s.calls(), 0);
  const results = await Promise.all([s.auth.google("google-callback", body), s.auth.google("google-callback", body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(s.calls(), 1);
  const expired = await s.start(); s.advance(601000);
  assert.equal((await s.auth.google("google-callback", expired.body)).code, "google_expired");
  assert.equal((await s.auth.google("google-callback", { ...body, code: "x".repeat(2049) })).status, 400);
});

for (const claims of [{ nonce: "wrong" }, { email_verified: false }, { iss: "https://attacker.invalid" }, { aud: "other-client" }, { sub: "" }, { email: "invalid" }]) {
  test(`rejects invalid Google identity: ${Object.keys(claims)[0]}`, async () => {
    const s = setup({ claims }), { body } = await s.start();
    assert.equal((await s.auth.google("google-callback", body)).status, 401);
    assert.equal(s.db.collections.get("customerSessions")?.length || 0, 0);
  });
}

test("signature and provider failures do not expose errors or create sessions", async () => {
  for (const overrides of [{ signatureFailure: true }, { fail: true }]) {
    const s = setup(overrides), { body } = await s.start();
    assert.deepEqual(await s.auth.google("google-callback", body), { status: 401, code: "google_failed" });
    assert.equal(s.db.collections.get("customerAccounts")?.length || 0, 0);
  }
});

test("existing password accounts are never linked solely by email, and disabled Google accounts stay blocked", async () => {
  const s = setup();
  await s.db.collection("customerAccounts").insertOne({ _id: "existing", email: "google@example.invalid", enabled: true, passwordHash: "untouched" });
  let flow = await s.start();
  assert.equal((await s.auth.google("google-callback", flow.body)).code, "google_link_required");
  const account = s.db.collections.get("customerAccounts")[0];
  assert.equal(account.googleSubject, undefined);
  Object.assign(account, { googleSubject: "google-subject-one", enabled: false });
  flow = await s.start();
  assert.equal((await s.auth.google("google-callback", flow.body)).status, 401);
});

test("Google fails closed when disabled, missing credentials or configured for a noncanonical callback", async () => {
  for (const config of [{ GOOGLE_AUTH_ENABLED: "false" }, { GOOGLE_CLIENT_SECRET: "" }, { GOOGLE_REDIRECT_URI: "https://preview.invalid/callback" }]) {
    const s = setup({ env: config });
    assert.deepEqual(await s.auth.google("google-start", {}), { status: 503, code: "google_unavailable" });
    assert.equal(s.db.collections.size, 0);
  }
});

test("Google start requests have persistent global rate limits", async () => {
  const s = setup();
  for (let i = 0; i < 100; i++) assert.equal((await s.auth.google("google-start", {})).status, 200);
  assert.equal((await s.auth.google("google-start", {})).status, 429);
});

test("Google profile uses explicit customer metadata and only trusted HTTPS profile images", async () => {
  for (const picture of ["https://lh3.googleusercontent.com/a/test", "javascript:alert(1)", "https://attacker.invalid/a.png"]) {
    const s = setup({ claims: { picture } }), flow = await s.start();
    const login = await s.auth.google("google-callback", flow.body);
    assert.equal(login.user.role, "user");
    assert.equal(login.user.status, "active");
    assert.equal(login.user.profileImage, picture.startsWith("https://lh3.") ? picture : null);
    const account = s.db.collections.get("customerAccounts")[0];
    assert.ok(account.createdAt && account.updatedAt && account.lastLoginAt);
    account.status = "suspended";
    assert.equal(await s.auth.session(login.token), null);
    const next = await s.start();
    assert.equal((await s.auth.google("google-callback", next.body)).status, 401);
  }
});

test("Google HTTP endpoints enforce origin, method, body size and return a safe unconfigured response", async t => {
  const route = createCustomerRoute({ NODE_ENV: "production" });
  const server = createServer((req, res) => route(req, res, new URL(req.url, "http://localhost").pathname));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/customer/google-start`;
  const headers = { Origin: "https://bluemindwebservice.com", "Content-Type": "application/json" };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(4100) })).status, 400);
  const response = await fetch(url, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "google_unavailable" });
});
