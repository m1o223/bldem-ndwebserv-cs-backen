import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

const ALLOWED_LOCALES = new Set(["en", "sv", "ar"]);
const MAX_NAME_LENGTH = 120;
const MAX_COMMENT_LENGTH = 1200;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeLocale(value) {
  return ALLOWED_LOCALES.has(value) ? value : "en";
}

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reviewId(value) {
  if (typeof value !== "string" || !ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

async function resolveOwner(req, db) {
  const customerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (TOKEN_PATTERN.test(customerToken)) {
    const session = await db.collection("customerSessions").findOne({ _id: hashToken(customerToken), expiresAt: { $gt: new Date() } });
    if (session) {
      const account = await db.collection("customerAccounts").findOne({ _id: session.customerId, enabled: true });
      if (account && (session.credentialVersion || 0) === (account.credentialVersion || 0)) {
        return { type: "account", id: String(account._id) };
      }
    }
  }

  const guestToken = req.headers["x-review-guest-token"];
  if (typeof guestToken === "string" && TOKEN_PATTERN.test(guestToken)) {
    return { type: "guest", id: hashToken(guestToken) };
  }
  return null;
}

function serializePublicReview(review, owner = null) {
  const createdAt = review.createdAt instanceof Date ? review.createdAt : new Date(review.createdAt);
  return {
    id: String(review._id),
    name: review.name,
    rating: review.rating,
    comment: review.comment,
    locale: normalizeLocale(review.locale),
    createdAt: createdAt.toISOString(),
    canEdit: Boolean(owner && review.ownerType === owner.type && review.ownerId === owner.id),
  };
}

export async function handlePublicReviews(req, res, env, readJsonBody) {
  const { getDatabase } = await import("./database.js");
  const db = await getDatabase(env);
  const collection = db.collection("publicReviews");
  await collection.createIndex({ status: 1, createdAt: -1 });
  await collection.createIndex({ ownerType: 1, ownerId: 1, createdAt: -1 });

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
    await collection.updateOne({ _id: id, ownerType: owner.type, ownerId: owner.id }, { $set: { name, rating, comment, locale: normalizeLocale(body?.locale), updatedAt: now } });
    const updated = await collection.findOne({ _id: id });
    return json(res, 200, { success: true, review: serializePublicReview(updated, owner) });
  }

  const review = {
    name,
    rating,
    comment,
    locale: normalizeLocale(body?.locale),
    ownerType: owner.type,
    ownerId: owner.id,
    status: "published",
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(review);
  return json(res, 201, { success: true, review: serializePublicReview({ ...review, _id: result.insertedId }, owner) });
}

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}
