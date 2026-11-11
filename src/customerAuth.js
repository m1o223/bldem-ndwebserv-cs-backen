import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDatabase } from "./database.js";
import { customerTypes, customerOverview, customerMessages, ensureCustomerMessageIndexes, markCustomerMessagesRead, saveCustomerProfile, customerContact, sendCustomerMessage } from "./customerWorkspace.js";
import { createCustomerGoogle } from "./customerGoogle.js";
import { activeCustomer, customerIdentity as identity } from "./customerIdentity.js";

export const CUSTOMER_SESSION_SECONDS = 8 * 60 * 60;
const WINDOW = 15 * 60 * 1000;
const hash = value => createHash("sha256").update(value).digest("hex");
const validToken = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// Unknown accounts take the same bcrypt path as valid accounts.
const dummyHash = bcrypt.hashSync(randomBytes(32).toString("hex"), 12);

export async function ensureCustomerIndexes(db) {
  await db.collection("customerAccounts").createIndex({ email: 1 }, { unique: true });
  await db.collection("customerSessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customerSessions").createIndex({ customerId: 1 });
  await db.collection("customerLoginLimits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ensureCustomerMessageIndexes(db);
}

export async function provisionInitialCustomer(db, env) {
  const email = env.CUSTOMER_INITIAL_EMAIL?.trim().toLowerCase();
  const passwordHash = env.CUSTOMER_INITIAL_PASSWORD_HASH;
  if (!email && !passwordHash) return;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(passwordHash || "")) throw new Error("Invalid customer provisioning configuration");
  await ensureCustomerIndexes(db);
  const accounts = db.collection("customerAccounts");
  if (await accounts.findOne({ email })) return;
  try {
    await accounts.insertOne({ _id: randomUUID(), email, displayName: email, profileImage: null, role: "user", status: "active", passwordHash, enabled: true, createdAt: new Date(), updatedAt: new Date() });
  } catch (error) { if (error.code !== 11000) throw error; }
}

export function createCustomerAuth({ database = () => getDatabase(), now = Date.now, env = {}, notify, googleClientFactory } = {}) {
  let provisioned;
  async function attempt(db, key, maximum) {
    const bucket = Math.floor(now() / WINDOW);
    const _id = hash(key) + ":" + bucket;
    const limits = db.collection("customerLoginLimits");
    try {
      await limits.updateOne({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * WINDOW) } }, { upsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      await limits.updateOne({ _id }, { $inc: { count: 1 } });
    }
    return (await limits.findOne({ _id })).count <= maximum;
  }
  async function issueSession(db, account, previousToken) {
    if (!activeCustomer(account)) return { status: 401, code: "credentials" };
    await ensureCustomerIndexes(db);
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(now() + CUSTOMER_SESSION_SECONDS * 1000);
    if (validToken(previousToken)) await db.collection("customerSessions").deleteOne({ _id: hash(previousToken) });
    await db.collection("customerSessions").insertOne({ _id: hash(token), customerId: account._id, expiresAt, createdAt: new Date(now()), credentialVersion: account.credentialVersion || 0 });
    await db.collection("customerAccounts").updateOne({ _id: account._id, enabled: true }, { $set: { profileImage: identity(account).profileImage, updatedAt: new Date(now()), lastLoginAt: new Date(now()) } });
    return { status: 200, token, user: identity(account), expiresAt: expiresAt.toISOString() };
  }
  return {
    google: createCustomerGoogle({ env, database, now, attempt, issueSession, clientFactory: googleClientFactory }),
    async login(body, previousToken) {
      if (!body || typeof body.email !== "string" || typeof body.password !== "string") return { status: 400, code: "invalid" };
      const email = body.email.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !body.password || Buffer.byteLength(body.password) > 72) return { status: 400, code: "invalid" };
      const db = await database();
      await ensureCustomerIndexes(db);
      provisioned ??= provisionInitialCustomer(db, env).catch(error => { provisioned = undefined; throw error; });
      await provisioned;
      if (!await attempt(db, "global", 100) || !await attempt(db, email, 5)) return { status: 429, code: "rate" };
      const account = await db.collection("customerAccounts").findOne({ email, enabled: true });
      const matches = await bcrypt.compare(body.password, account?.passwordHash || dummyHash);
      if (!activeCustomer(account) || !matches) return { status: 401, code: "credentials" };
      // This optional choice can never prevent a valid customer from signing in.
      if (body.customerType && customerTypes.includes(body.customerType)) {
        await db.collection("customerAccounts").updateOne({ _id: account._id }, { $set: { customerType: body.customerType, updatedAt: new Date() } });
      }
      return issueSession(db, account, previousToken);
    },
    async session(token) {
      if (!validToken(token)) return null;
      const db = await database();
      const session = await db.collection("customerSessions").findOne({ _id: hash(token), expiresAt: { $gt: new Date(now()) } });
      if (!session) return null;
      const account = await db.collection("customerAccounts").findOne({ _id: session.customerId, enabled: true });
      return activeCustomer(account) && (session.credentialVersion || 0) === (account.credentialVersion || 0) ? identity(account) : null;
    },
    async logout(token) {
      if (validToken(token)) await (await database()).collection("customerSessions").deleteOne({ _id: hash(token) });
    },
    async workspace(action, token, body) {
      const user = await this.session(token);
      if (!user) return { status: 401, code: "credentials" };
      const db = await database();
      if (action === "overview") return { status: 200, ...(await customerOverview(db, user)) };
      if (action === "messages") return { status: 200, ...(await customerMessages(db, user)) };
      if (action === "messages-read") return { status: 200, ...(await markCustomerMessagesRead(db, user)) };
      if (!await attempt(db, `customer:${action}:${user.id}`, ["contact", "password", "message"].includes(action) ? 5 : 30)) return { status: 429, code: "rate" };
      if (action === "message") return await sendCustomerMessage(db, user, body);
      if (action === "password") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["currentPassword", "newPassword"].includes(key)) || typeof body.currentPassword !== "string" || !body.currentPassword || Buffer.byteLength(body.currentPassword) > 72 || typeof body.newPassword !== "string" || [...body.newPassword].length < 15 || Buffer.byteLength(body.newPassword) > 72 || body.currentPassword === body.newPassword) return { status: 400, code: "invalid" };
        const account = await db.collection("customerAccounts").findOne({ _id: user.id });
        if (!activeCustomer(account) || !account.passwordHash || !await bcrypt.compare(body.currentPassword, account.passwordHash)) return { status: 400, code: "invalid" };
        const passwordHash = await bcrypt.hash(body.newPassword, 12);
        // Compare-and-swap prevents concurrent password changes from overwriting each other.
        const changed = await db.collection("customerAccounts").updateOne({ _id: user.id, passwordHash: account.passwordHash, enabled: true }, { $set: { passwordHash, updatedAt: new Date(now()) }, $inc: { credentialVersion: 1 } });
        if (changed.matchedCount !== 1) return { status: 400, code: "invalid" };
        // Version checking revokes every existing session, including concurrent login requests.
        await db.collection("customerSessions").deleteMany({ customerId: user.id });
        return { status: 200, success: true };
      }
      if (action === "profile") return await saveCustomerProfile(db, user, body) ? { status: 200, success: true } : { status: 400, code: "invalid" };
      if (action === "contact") return customerContact(db, user, body, env, notify);
      return { status: 404, code: "missing" };
    },
  };
}

async function readBody(req, maximum = 2048) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("invalid");
  if (Number(req.headers["content-length"]) > maximum) throw new Error("invalid");
  const chunks = [];
  let size = 0;
  const timeout = setTimeout(() => req.destroy(), 10000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximum) throw new Error("invalid");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timeout); }
}

export function createCustomerRoute(env = process.env, options = {}) {
  const auth = createCustomerAuth({ database: () => getDatabase(env), env, ...options });
  const origins = new Set(["https://bluemind-web-service.vercel.app", "https://bluemindwebservice.com", "https://www.bluemindwebservice.com"]);
  if (env.NODE_ENV !== "production") origins.add("http://localhost:3199");
  return async (req, res, pathname) => {
    const reply = (status, body) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (status === 429) res.setHeader("Retry-After", "900");
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    // Browser access is same-origin through Vercel; Render never sets workspace cookies.
    if (!origins.has(req.headers.origin)) return reply(403, { code: "forbidden" });
    const action = pathname.slice("/api/customer/".length);
    if (!["login", "session", "logout", "overview", "messages", "messages-read", "message", "profile", "contact", "password", "google-start", "google-callback"].includes(action)) return reply(404, { code: "missing" });
    if (req.method !== (["session", "overview", "messages"].includes(action) ? "GET" : "POST")) return reply(405, { code: "method" });
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    try {
      if (action === "google-start" || action === "google-callback") {
        let body;
        try { body = await readBody(req, 4096); } catch { return reply(400, { code: "invalid" }); }
        const { status, ...result } = await auth.google(action, body, token);
        console.info(JSON.stringify({ event: "customer_google", stage: action, status, outcome: result.code || "success" }));
        return reply(status, result);
      }
      if (action === "session") {
        const user = await auth.session(token);
        return reply(user ? 200 : 401, { user });
      }
      if (action === "logout") {
        await auth.logout(token);
        return reply(200, { success: true });
      }
      if (action === "overview" || action === "messages") {
        const { status, ...result } = await auth.workspace(action, token);
        return reply(status, result);
      }
      if (action !== "login" && !await auth.session(token)) return reply(401, { code: "credentials" });
      let body;
      try { body = await readBody(req, action === "login" ? 2048 : 20000); } catch { return reply(400, { code: "invalid" }); }
      const { status, ...result } = action === "login" ? await auth.login(body, token) : await auth.workspace(action, token, body);
      return reply(status, result);
    } catch (error) {
      if (action.startsWith("google-")) console.warn(JSON.stringify({ event: "customer_google", stage: action, status: 503, outcome: "internal_failure", databaseCode: [11000, 85, 86, 18].includes(error?.code) ? error.code : null }));
      return reply(503, { code: "unavailable" });
    }
  };
}
