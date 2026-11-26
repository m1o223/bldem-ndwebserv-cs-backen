import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { requestEmailVerification, verifyEmailCode } from "../src/emailVerification.js";
import { handlePublicReviews } from "../src/publicReviews.js";

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$gt" in expected) return actual instanceof Date && actual > expected.$gt;
      if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    }
    if (expected instanceof ObjectId || actual instanceof ObjectId) return String(actual) === String(expected);
    return actual === expected;
  });
}

class FakeCollection {
  constructor() { this.docs = []; }
  async createIndex() {}
  async findOne(filter = {}, options = {}) {
    const found = this.docs.filter(doc => matches(doc, filter));
    if (options.sort) {
      const [[key, direction]] = Object.entries(options.sort);
      found.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction);
    }
    return found[0] || null;
  }
  find(filter = {}) {
    let found = this.docs.filter(doc => matches(doc, filter));
    const chain = {
      sort: (spec) => { const [[key, direction]] = Object.entries(spec); found.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction); return chain; },
      limit: (count) => { found = found.slice(0, count); return chain; },
      toArray: async () => found,
    };
    return chain;
  }
  async insertOne(value) {
    const doc = { ...value, _id: value._id || new ObjectId() };
    this.docs.push(doc);
    return { insertedId: doc._id };
  }
  async updateOne(filter, update) {
    const doc = await this.findOne(filter);
    if (!doc) return { matchedCount: 0 };
    Object.assign(doc, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + amount;
    return { matchedCount: 1 };
  }
  async updateMany(filter, update) {
    for (const doc of this.docs.filter(item => matches(item, filter))) Object.assign(doc, update.$set || {});
  }
}

class FakeDb {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
    return this.collections.get(name);
  }
}

function request(method, body, headers = {}) {
  return { method, body, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function response() {
  return {
    status: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.status = status; },
    end(value) { this.body = JSON.parse(value); },
  };
}

const env = {
  ADMIN_SESSION_SECRET: "review-test-secret-that-is-long-enough",
  NODE_ENV: "test",
  REVIEWS_ALLOWED_EMAIL: "customer@example.com",
  REVIEWS_ALLOWED_ORDER: "#999",
};
const readJsonBody = async req => req.body;

test("reviews require a real matching order and verified email, keep internal fields private, and enforce owner edits", async () => {
  const db = new FakeDb();
  await db.collection("orders").insertOne({ orderNumber: "#999", verifiedEmail: "customer@example.com", isPaidOrder: true });
  const guestToken = "a".repeat(64);
  const headers = { "x-review-guest-token": guestToken, "content-type": "application/json", "x-review-idempotency-key": "review-request-123456" };
  let sent;
  await requestEmailVerification({
    env,
    db,
    body: { email: "customer@example.com", checkoutAttemptId: "review-attempt" },
    sendEmail: async (_env, message) => { sent = message; return { sent: true }; },
  });
  const verified = await verifyEmailCode({ env, db, body: { email: "customer@example.com", checkoutAttemptId: "review-attempt", code: sent.code } });

  const invalidResponse = response();
  await handlePublicReviews(request("POST", {
    name: "Customer", rating: 5, comment: "A real review", email: "customer@example.com", orderNumber: "#999", checkoutAttemptId: "review-attempt", emailVerificationToken: "wrong-token",
  }, headers), invalidResponse, env, readJsonBody, db);
  assert.equal(invalidResponse.status, 403);
  assert.equal(db.collection("publicReviews").docs.length, 0);

  const createdResponse = response();
  const payload = {
    name: "Customer", rating: 5, comment: "A real review", email: "customer@example.com", orderNumber: "#999", checkoutAttemptId: "review-attempt", emailVerificationToken: verified.verificationToken, locale: "en",
  };
  await handlePublicReviews(request("POST", payload, headers), createdResponse, env, readJsonBody, db);
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.body.review.name, "Customer");
  assert.equal("email" in createdResponse.body.review, false);
  assert.equal("orderNumber" in createdResponse.body.review, false);
  assert.equal("ownerEmailHash" in createdResponse.body.review, false);

  const duplicateResponse = response();
  await handlePublicReviews(request("POST", payload, headers), duplicateResponse, env, readJsonBody, db);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.body.review.id, createdResponse.body.review.id);
  assert.equal(db.collection("publicReviews").docs.length, 1);

  const otherHeaders = { ...headers, "x-review-guest-token": "b".repeat(64) };
  const publicResponse = response();
  await handlePublicReviews(request("GET", undefined, otherHeaders), publicResponse, env, readJsonBody, db);
  assert.equal(publicResponse.body.reviews.length, 1);
  assert.equal(publicResponse.body.reviews[0].canEdit, false);
  assert.equal("email" in publicResponse.body.reviews[0], false);
  assert.equal("orderNumber" in publicResponse.body.reviews[0], false);

  const forbiddenEdit = response();
  await handlePublicReviews(request("PATCH", { id: createdResponse.body.review.id, name: "Other", rating: 1, comment: "Not mine" }, otherHeaders), forbiddenEdit, env, readJsonBody, db);
  assert.equal(forbiddenEdit.status, 403);
});

test("sandbox and demo orders cannot be used to publish a review", async () => {
  const db = new FakeDb();
  await db.collection("orders").insertOne({ orderNumber: "#515", verifiedEmail: "customer@example.com", isSandboxTestOrder: true });
  const result = response();
  await handlePublicReviews(request("POST", { name: "Customer", rating: 5, comment: "No", email: "customer@example.com", orderNumber: "515", checkoutAttemptId: "x", emailVerificationToken: "x" }, { "x-review-guest-token": "c".repeat(64), "content-type": "application/json" }), result, env, readJsonBody, db);
  assert.equal(result.status, 403);
  assert.equal(db.collection("publicReviews").docs.length, 0);
});
