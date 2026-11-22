const ALLOWED_LOCALES = new Set(["en", "sv", "ar"]);
const MAX_COMMENT_LENGTH = 1200;

function cleanComment(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_COMMENT_LENGTH);
}

function normalizeLocale(value) {
  return ALLOWED_LOCALES.has(value) ? value : "en";
}

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

export function serializePublicReview(review) {
  return {
    id: String(review._id),
    rating: review.rating,
    comment: review.comment,
    locale: normalizeLocale(review.locale),
    createdAt: review.createdAt instanceof Date ? review.createdAt.toISOString() : new Date(review.createdAt).toISOString(),
  };
}

export async function handlePublicReviews(req, res, env, readJsonBody) {
  const { getDatabase } = await import("./database.js");
  const db = await getDatabase(env);
  await db.collection("publicReviews").createIndex({ status: 1, createdAt: -1 });

  if (req.method === "GET") {
    const reviews = await db.collection("publicReviews")
      .find({ status: "published" })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    return json(res, 200, { success: true, reviews: reviews.map(serializePublicReview) });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const body = await readJsonBody(req);
  const rating = normalizeRating(body?.rating);
  const comment = cleanComment(body?.comment);
  if (!rating) return json(res, 400, { success: false, error: "Please choose a rating from 1 to 5." });
  if (!comment) return json(res, 400, { success: false, error: "Please write a comment before publishing." });

  const now = new Date();
  const review = {
    rating,
    comment,
    locale: normalizeLocale(body?.locale),
    status: "published",
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection("publicReviews").insertOne(review);
  return json(res, 201, { success: true, review: serializePublicReview({ ...review, _id: result.insertedId }) });
}

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}
