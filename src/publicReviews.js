import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { requestEmailVerification, verifyEmailToken } from "./emailVerification.js";
import { normalizeOrderNumber } from "./orders.js";

const ALLOWED_LOCALES = new Set(["en", "sv", "ar"]);
const MAX_NAME_LENGTH = 120;
const MAX_COMMENT_LENGTH = 1200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,120}$/;
const reviewIndexInitialization = new WeakMap();

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function normalizeLocale(value) {
  return ALLOWED_LOCALES.has(value) ? value : "en";
}

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function reviewId(value) {
  if (typeof value !== "string" || !ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

function reviewAllowlist(env) {
  const email = normalizeEmail(env.REVIEWS_ALLOWED_EMAIL);
  const orderNumber = normalizeOrderNumber(env.REVIEWS_ALLOWED_ORDER);
  if (!email || !orderNumber || !EMAIL_PATTERN.test(email) || !/^#\d+$/.test(orderNumber)) return null;
  return { email, orderNumber };
}

function matchesReviewAllowlist(env, email, orderNumber) {
  const allowlist = reviewAllowlist(env);
  if (allowlist) return allowlist.email === email && allowlist.orderNumber === orderNumber;
  return String(env.REVIEWS_ALLOW_VERIFIED_CUSTOMERS || "").toLowerCase() === "true";
}

function reviewVerificationError() {
  return "We could not verify that this order belongs to this email address.";
}

async function findEligibleOrder(db, email, rawOrderNumber) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!EMAIL_PATTERN.test(email) || !/^#\d+$/.test(orderNumber)) return null;
  const order = await db.collection("orders").findOne({ orderNumber });
  if (!order || order.isDemo === true || order.isSandboxTestOrder === true) return null;
  const orderEmail = normalizeEmail(order.verifiedEmail || order.email);
  if (!orderEmail || orderEmail !== email) return null;
  return { order, orderNumber, email };
}

async function resolveOwner(req, db) {
  const customerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (TOKEN_PATTERN.test(customerToken)) {
    const session = await db.collection("customerSessions").findOne({ _id: hashValue(customerToken), expiresAt: { $gt: new Date() } });
    if (session) {
      const account = await db.collection("customerAccounts").findOne({ _id: session.customerId, enabled: true });
      if (account && (session.credentialVersion || 0) === (account.credentialVersion || 0)) {
        return { type: "account", id: String(account._id), email: normalizeEmail(account.email) };
      }
    }
  }

  const guestToken = req.headers["x-review-guest-token"];
  if (typeof guestToken === "string" && TOKEN_PATTERN.test(guestToken)) {
    return { type: "guest", id: hashValue(guestToken), email: "" };
  }
  return null;
}

async function ensureReviewIndexes(collection, db) {
  const existing = reviewIndexInitialization.get(db);
  if (existing) return existing;
  const initialization = Promise.all([
    collection.createIndex({ status: 1, createdAt: -1 }),
    collection.createIndex({ ownerType: 1, ownerId: 1, createdAt: -1 }),
    collection.createIndex(
      { ownerType: 1, ownerId: 1, idempotencyKey: 1 },
      { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
    ),
  ]).catch(error => {
    reviewIndexInitialization.delete(db);
    throw error;
  });
  reviewIndexInitialization.set(db, initialization);
  return initialization;
}

function serializePublicReview(review, owner = null) {
  const createdAt = review.createdAt instanceof Date ? review.createdAt : new Date(review.createdAt);
  return {
    id: String(review._id),
    name: review.name,
    rating: review.rating,
    comment: review.comment,
    locale: normalizeLocale(review.locale),
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(0).toISOString() : createdAt.toISOString(),
    canEdit: Boolean(owner && review.ownerType === owner.type && review.ownerId === owner.id),
  };
}

export async function handleReviewVerificationSend(req, res, env, readJsonBody, providedDb) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body?.email);
  const orderNumber = normalizeOrderNumber(body?.orderNumber);
  const { getDatabase } = await import("./database.js");
  const db = providedDb || await getDatabase(env);
  const order = await findEligibleOrder(db, email, orderNumber);
  if (!order || !matchesReviewAllowlist(env, email, orderNumber)) {
    return json(res, 403, { success: false, error: reviewVerificationError() });
  }

  const verification = await requestEmailVerification({
    env,
    db,
    body: { email, language: body?.language, checkoutAttemptId: body?.checkoutAttemptId },
    ip: req.socket.remoteAddress,
  });
  return json(res, 200, { success: true, message: "Verification code sent.", verification });
}

export async function handlePublicReviews(req, res, env, readJsonBody, providedDb) {
  const { getDatabase } = await import("./database.js");
  const db = providedDb || await getDatabase(env);
  const collection = db.collection("publicReviews");
  await ensureReviewIndexes(collection, db);

  const owner = await resolveOwner(req, db);

  if (req.method === "GET") {
    const reviews = await collection
      .find({ status: "published" })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    return json(res, 200, { success: true, reviews: reviews.map(review => serializePublicReview(review, owner)) });
  }

  if (!["POST", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!owner) return json(res, 401, { success: false, error: "Review ownership could not be verified." });

  const body = await readJsonBody(req);
  const name = cleanText(body?.name, MAX_NAME_LENGTH);
  const rating = normalizeRating(body?.rating);
  const comment = cleanText(body?.comment, MAX_COMMENT_LENGTH);
  if (!name) return json(res, 400, { success: false, error: "Please enter a username." });
  if (!rating) return json(res, 400, { success: false, error: "Please choose a rating from 1 to 5." });
  if (!comment) return json(res, 400, { success: false, error: "Please write a comment before publishing." });

  const now = new Date();
  if (req.method === "PATCH") {
    const id = reviewId(body?.id);
    if (!id) return json(res, 400, { success: false, error: "Review not found." });
    const current = await collection.findOne({ _id: id, status: "published" });
    if (!current) return json(res, 404, { success: false, error: "Review not found." });
    if (current.ownerType !== owner.type || current.ownerId !== owner.id) return json(res, 403, { success: false, error: "You can only edit your own review." });
    await collection.updateOne(
      { _id: id, ownerType: owner.type, ownerId: owner.id, status: "published" },
      { $set: { name, rating, comment, locale: normalizeLocale(body?.locale), updatedAt: now } },
    );
    const updated = await collection.findOne({ _id: id });
    return json(res, 200, { success: true, review: serializePublicReview(updated, owner) });
  }

  const email = normalizeEmail(body?.email);
  const orderNumber = normalizeOrderNumber(body?.orderNumber);
  if (!EMAIL_PATTERN.test(email) || !/^#\d+$/.test(orderNumber)) return json(res, 400, { success: false, error: reviewVerificationError() });
  if (!matchesReviewAllowlist(env, email, orderNumber)) return json(res, 403, { success: false, error: reviewVerificationError() });

  try {
    await verifyEmailToken(db, {
      email,
      checkoutAttemptId: body?.checkoutAttemptId,
      token: body?.emailVerificationToken,
    });
  } catch {
    return json(res, 403, { success: false, error: "Please verify your email before publishing a review." });
  }

  const eligibleOrder = await findEligibleOrder(db, email, orderNumber);
  if (!eligibleOrder) return json(res, 403, { success: false, error: reviewVerificationError() });
  if (owner.type === "account" && owner.email !== email) return json(res, 403, { success: false, error: reviewVerificationError() });

  const idempotencyKey = String(req.headers["x-review-idempotency-key"] || "");
  if (IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    const existing = await collection.findOne({ ownerType: owner.type, ownerId: owner.id, idempotencyKey, status: "published" });
    if (existing) return json(res, 200, { success: true, review: serializePublicReview(existing, owner) });
  }

  const review = {
    name,
    rating,
    comment,
    locale: normalizeLocale(body?.locale),
    ownerType: owner.type,
    ownerId: owner.id,
    ownerEmailHash: hashValue(email),
    orderNumber,
    status: "published",
    createdAt: now,
    updatedAt: now,
    ...(IDEMPOTENCY_PATTERN.test(idempotencyKey) ? { idempotencyKey } : {}),
  };
  try {
    const result = await collection.insertOne(review);
    return json(res, 201, { success: true, review: serializePublicReview({ ...review, _id: result.insertedId }, owner) });
  } catch (error) {
    if (error?.code === 11000 && IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      const existing = await collection.findOne({ ownerType: owner.type, ownerId: owner.id, idempotencyKey, status: "published" });
      if (existing) return json(res, 200, { success: true, review: serializePublicReview(existing, owner) });
    }
    throw error;
  }
}

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}
