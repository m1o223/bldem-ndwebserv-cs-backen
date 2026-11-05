import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { activeCustomer, profileImage } from "./customerIdentity.js";

export const GOOGLE_CALLBACK_URL = "https://bluemindwebservice.com/api/auth/callback/google";
export const GOOGLE_FLOW_SECONDS = 600;
const hash = value => createHash("sha256").update(value).digest("hex");
const opaque = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// Never log SDK errors: they can contain authorization codes, tokens and secrets.
export function googleFailureDiagnostic(stage, error) {
  const providerCode = error?.response?.data?.error;
  return { event: "customer_google", stage,
    reason: ["invalid_client", "invalid_grant", "redirect_uri_mismatch", "access_denied"].includes(providerCode) ? providerCode : "provider_failure",
    status: Number.isInteger(error?.response?.status) ? error.response.status : null };
}

export function createCustomerGoogle({ env, database, now, attempt, issueSession, clientFactory = options => new OAuth2Client(options) }) {
  function client() {
    if (env.GOOGLE_AUTH_ENABLED !== "true" || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_REDIRECT_URI !== GOOGLE_CALLBACK_URL) return null;
    return clientFactory({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: GOOGLE_CALLBACK_URL, transporterOptions: { timeout: 5000, retry: false, signal: AbortSignal.timeout(10000) } });
  }
  return async (action, body, previousToken) => {
    const google = client();
    if (!google) return { status: 503, code: "google_unavailable" };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, code: "invalid" };
    const db = await database();
    await db.collection("customerLoginLimits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    if (!await attempt(db, `google:${action}`, action === "google-start" ? 100 : 150)) return { status: 429, code: "rate" };
    const flows = db.collection("customerGoogleFlows");
    await flows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    if (action === "google-start") {
      const state = randomBytes(32).toString("hex"), browserToken = randomBytes(32).toString("hex"), nonce = randomBytes(32).toString("hex");
      const { codeVerifier, codeChallenge } = await google.generateCodeVerifierAsync();
      await flows.insertOne({ _id: hash(state), browserHash: hash(browserToken), nonce, codeVerifier, expiresAt: new Date(now() + GOOGLE_FLOW_SECONDS * 1000), customerType: ["private", "company"].includes(body.customerType) ? body.customerType : null });
      return { status: 200, browserToken, authorizationUrl: google.generateAuthUrl({ scope: ["openid", "email", "profile"], state, nonce, response_type: "code", access_type: "online", prompt: "select_account", code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }) };
    }
    if (!opaque(body.state) || !opaque(body.browserToken) || typeof body.code !== "string" || !body.code || body.code.length > 2048) return { status: 400, code: "invalid" };
    // Atomic consumption prevents concurrent callbacks or replay from reusing a code.
    const flow = await flows.findOneAndDelete({ _id: hash(body.state), browserHash: hash(body.browserToken), expiresAt: { $gt: new Date(now()) } });
    if (!flow) return { status: 400, code: "google_expired" };
    let claims;
    let stage = "token_exchange";
    try {
      const { tokens } = await google.getToken({ code: body.code, codeVerifier: flow.codeVerifier, redirect_uri: GOOGLE_CALLBACK_URL });
      stage = "identity_verification";
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
      claims = ticket.getPayload();
    } catch (error) {
      console.warn(JSON.stringify(googleFailureDiagnostic(stage, error)));
      return { status: 401, code: "google_failed" };
    }
    if (!claims || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || claims.nonce !== flow.nonce || claims.email_verified !== true || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || typeof claims.email !== "string" || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) return { status: 401, code: "google_failed" };
    const accounts = db.collection("customerAccounts");
    await accounts.createIndex({ email: 1 }, { unique: true });
    await accounts.createIndex({ googleSubject: 1 }, { unique: true, sparse: true });
    let account = await accounts.findOne({ googleSubject: claims.sub });
    if (!account) {
      const email = claims.email.trim().toLowerCase();
      // An existing password account needs a separately authenticated linking flow.
      if (await accounts.findOne({ email })) return { status: 409, code: "google_link_required" };
      account = { _id: randomUUID(), email, displayName: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 160) : email, googleSubject: claims.sub, enabled: true, role: "user", status: "active", profileImage: profileImage(claims.picture), createdAt: new Date(now()), updatedAt: new Date(now()), customerType: flow.customerType };
      try { await accounts.insertOne(account); }
      catch (error) {
        if (error.code !== 11000) throw error;
        account = await accounts.findOne({ googleSubject: claims.sub });
        if (!account) return { status: 409, code: "google_link_required" };
      }
    }
    if (!activeCustomer(account)) return { status: 401, code: "credentials" };
    if (profileImage(claims.picture)) account = { ...account, profileImage: profileImage(claims.picture) };
    if (flow.customerType) await accounts.updateOne({ _id: account._id }, { $set: { customerType: flow.customerType, updatedAt: new Date(now()) } });
    return issueSession(db, account, previousToken);
  };
}
