import test from "node:test";
import assert from "node:assert/strict";
import {
  requestEmailVerification,
  verifyEmailCode,
  verifyEmailToken,
} from "../src/emailVerification.js";

const env = { ADMIN_SESSION_SECRET: "test-secret-that-is-long-enough-for-verification" };

class FakeVerificationCollection {
  constructor() {
    this.docs = [];
  }

  matches(doc, filter = {}) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key];
      if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
        if ("$gt" in expected) return actual instanceof Date && actual > expected.$gt;
        if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      }
      return actual === expected;
    });
  }

  sortDocs(docs, sort = {}) {
    const [[key, direction] = []] = Object.entries(sort);
    if (!key) return docs;
    return [...docs].sort((a, b) => {
      const av = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
      return direction < 0 ? bv - av : av - bv;
    });
  }

  async findOne(filter, options = {}) {
    return this.sortDocs(this.docs.filter(doc => this.matches(doc, filter)), options.sort)[0] || null;
  }

  async insertOne(doc) {
    this.docs.push({ ...doc });
    return { acknowledged: true, insertedId: doc._id };
  }

  applyUpdate(doc, update) {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [key, amount] of Object.entries(update.$inc)) doc[key] = (doc[key] || 0) + amount;
    }
  }

  async updateOne(filter, update) {
    const doc = await this.findOne(filter);
    if (doc) this.applyUpdate(doc, update);
    return { acknowledged: true };
  }

  async updateMany(filter, update) {
    for (const doc of this.docs.filter(item => this.matches(item, filter))) this.applyUpdate(doc, update);
    return { acknowledged: true };
  }
}

function fakeDb(collection = new FakeVerificationCollection()) {
  return { collection: () => collection, collectionRef: collection };
}

test("email verification sends a localized code without exposing it in the response", async () => {
  const db = fakeDb();
  let sent;
  const result = await requestEmailVerification({
    env,
    db,
    ip: "203.0.113.4",
    body: { email: "CUSTOMER@example.com", language: "sv", checkoutAttemptId: "attempt-1" },
    sendEmail: async (_env, message) => {
      sent = message;
      return { sent: true };
    },
  });

  assert.equal(result.email, "customer@example.com");
  assert.equal(result.checkoutAttemptId, "attempt-1");
  assert.equal(result.resendAfterSeconds, 60);
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(sent.language, "sv");
  assert.equal(result.code, undefined);
  assert.notEqual(db.collectionRef.docs[0].codeHash, sent.code);
});

test("email verification accepts the correct code once and returns a server-verifiable token", async () => {
  const db = fakeDb();
  let sent;
  await requestEmailVerification({
    env,
    db,
    ip: "203.0.113.4",
    body: { email: "customer@example.com", checkoutAttemptId: "attempt-2" },
    sendEmail: async (_env, message) => { sent = message; return { sent: true }; },
  });

  const verified = await verifyEmailCode({ env, db, body: { email: "customer@example.com", checkoutAttemptId: "attempt-2", code: sent.code } });
  assert.equal(verified.email, "customer@example.com");
  assert.ok(verified.verificationToken.length > 30);

  const tokenCheck = await verifyEmailToken(db, { email: "customer@example.com", checkoutAttemptId: "attempt-2", token: verified.verificationToken });
  assert.equal(tokenCheck.email, "customer@example.com");

  await assert.rejects(() => verifyEmailCode({ env, db, body: { email: "customer@example.com", checkoutAttemptId: "attempt-2", code: sent.code } }), /already been used/);
});

test("email verification rejects invalid, expired, superseded, and over-attempted codes", async () => {
  const db = fakeDb();
  let sent;
  await requestEmailVerification({
    env,
    db,
    body: { email: "customer@example.com", checkoutAttemptId: "attempt-3" },
    sendEmail: async (_env, message) => { sent = message; return { sent: true }; },
  });

  await assert.rejects(() => verifyEmailCode({ env, db, body: { email: "customer@example.com", checkoutAttemptId: "attempt-3", code: "000000" } }), /Incorrect code/);
  db.collectionRef.docs[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => verifyEmailCode({ env, db, body: { email: "customer@example.com", checkoutAttemptId: "attempt-3", code: sent.code } }), /expired/);

  const db2 = fakeDb();
  await requestEmailVerification({ env, db: db2, body: { email: "a@example.com", checkoutAttemptId: "attempt-4" }, sendEmail: async () => ({ sent: true }) });
  db2.collectionRef.docs[0].createdAt = new Date(Date.now() - 61_000);
  await requestEmailVerification({ env, db: db2, body: { email: "a@example.com", checkoutAttemptId: "attempt-4" }, sendEmail: async () => ({ sent: true }) });
  assert.ok(db2.collectionRef.docs[0].supersededAt instanceof Date);

  const db3 = fakeDb();
  await requestEmailVerification({ env, db: db3, body: { email: "b@example.com", checkoutAttemptId: "attempt-5" }, sendEmail: async () => ({ sent: true }) });
  db3.collectionRef.docs[0].attempts = 5;
  await assert.rejects(() => verifyEmailCode({ env, db: db3, body: { email: "b@example.com", checkoutAttemptId: "attempt-5", code: "111111" } }), /Too many/);
});

test("email verification enforces invalid email and resend cooldown", async () => {
  const db = fakeDb();
  await assert.rejects(() => requestEmailVerification({ env, db, body: { email: "bad" }, sendEmail: async () => ({ sent: true }) }), /Validation failed/);
  await requestEmailVerification({ env, db, body: { email: "cooldown@example.com", checkoutAttemptId: "attempt-6" }, sendEmail: async () => ({ sent: true }) });
  await assert.rejects(() => requestEmailVerification({ env, db, body: { email: "cooldown@example.com", checkoutAttemptId: "attempt-6" }, sendEmail: async () => ({ sent: true }) }), /Please wait/);
});
