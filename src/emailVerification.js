import { createHash, randomBytes, randomInt, timingSafeEqual, randomUUID } from "node:crypto";
import { sendEmailVerificationCode } from "./email.js";
import { ValidationError } from "./validation.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function normalizeLanguage(value) {
  return value === "sv" || value === "ar" ? value : "en";
}

function getVerificationSecret(env) {
  const secret = cleanString(env.EMAIL_VERIFICATION_SECRET || env.ADMIN_SESSION_SECRET || env.RESEND_API_KEY, 500);
  if (!secret) throw Object.assign(new Error("Email verification is not configured."), { statusCode: 503 });
  return secret;
}

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function hashCode({ code, salt, email, checkoutAttemptId, secret }) {
  return createHash("sha256")
    .update(secret)
    .update(":")
    .update(salt)
    .update(":")
    .update(email)
    .update(":")
    .update(checkoutAttemptId)
    .update(":")
    .update(code)
    .digest("hex");
}

function safeEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateEmailOrThrow(email) {
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError({ email: "Please enter a valid email address." });
}

function verificationError(message = "The verification code is invalid or expired.", statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanAttemptId(value) {
  const cleaned = cleanString(value, 120);
  return cleaned || randomUUID();
}

export function generateSixDigitCode() {
  return String(randomInt(100000, 1000000));
}

export async function requestEmailVerification({ env, db, body, ip, sendEmail = sendEmailVerificationCode }) {
  const email = normalizeEmail(body?.email);
  validateEmailOrThrow(email);
  const language = normalizeLanguage(body?.language);
  const checkoutAttemptId = cleanAttemptId(body?.checkoutAttemptId);
  const now = new Date();
  const cooldownSince = new Date(now.getTime() - RESEND_COOLDOWN_MS);
  const collection = db.collection("orderEmailVerifications");

  const recent = await collection.findOne({ email, createdAt: { $gt: cooldownSince } }, { sort: { createdAt: -1 } });
  if (recent) throw verificationError("Please wait before requesting another verification code.", 429);

  await collection.updateMany(
    { email, usedAt: { $exists: false }, supersededAt: { $exists: false } },
    { $set: { supersededAt: now, updatedAt: now } },
  );

  const code = generateSixDigitCode();
  const salt = randomBytes(16).toString("hex");
  const secret = getVerificationSecret(env);
  const doc = {
    _id: randomUUID(),
    email,
    checkoutAttemptId,
    language,
    codeHash: hashCode({ code, salt, email, checkoutAttemptId, secret }),
    salt,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    ipHash: ip ? hashValue(ip) : undefined,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  };

  await collection.insertOne(doc);

  try {
    const delivery = await sendEmail(env, { email, code, language, expiresInMinutes: 10 });
    await collection.updateOne({ _id: doc._id }, { $set: { sentAt: new Date(), delivery, updatedAt: new Date() } });
  } catch (error) {
    await collection.updateOne({ _id: doc._id }, { $set: { sendFailedAt: new Date(), updatedAt: new Date() } });
    throw Object.assign(new Error("We could not send the verification email. Please try again later."), { statusCode: 502 });
  }

  return {
    email,
    checkoutAttemptId,
    expiresInSeconds: Math.floor(CODE_TTL_MS / 1000),
    resendAfterSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
  };
}

export async function verifyEmailCode({ env, db, body }) {
  const email = normalizeEmail(body?.email);
  validateEmailOrThrow(email);
  const checkoutAttemptId = cleanAttemptId(body?.checkoutAttemptId);
  const code = cleanString(body?.code, 12).replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) throw new ValidationError({ code: "Enter the 6-digit verification code." });

  const collection = db.collection("orderEmailVerifications");
  const doc = await collection.findOne({ email, checkoutAttemptId, supersededAt: { $exists: false } }, { sort: { createdAt: -1 } });
  if (!doc) throw verificationError();

  const now = new Date();
  if (doc.usedAt) throw verificationError("This verification code has already been used.");
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= now.getTime()) throw verificationError("The verification code has expired. Please request a new code.");
  if ((doc.attempts || 0) >= (doc.maxAttempts || MAX_ATTEMPTS)) throw verificationError("Too many verification attempts. Please request a new code.", 429);

  const expectedHash = hashCode({ code, salt: doc.salt, email, checkoutAttemptId, secret: getVerificationSecret(env) });
  if (!safeEqualHex(expectedHash, doc.codeHash)) {
    await collection.updateOne({ _id: doc._id }, { $inc: { attempts: 1 }, $set: { lastAttemptAt: now, updatedAt: now } });
    throw verificationError("Incorrect code. Please try again.");
  }

  const verificationToken = randomBytes(32).toString("base64url");
  const verificationTokenHash = hashValue(verificationToken);
  const tokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  await collection.updateOne(
    { _id: doc._id },
    {
      $set: {
        usedAt: now,
        verifiedAt: now,
        verificationTokenHash,
        tokenExpiresAt,
        updatedAt: now,
      },
    },
  );

  return {
    email,
    checkoutAttemptId,
    verificationToken,
    tokenExpiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
  };
}

export async function verifyEmailToken(db, { email, checkoutAttemptId, token }) {
  const normalizedEmail = normalizeEmail(email);
  validateEmailOrThrow(normalizedEmail);
  const cleanToken = cleanString(token, 300);
  const cleanCheckoutAttemptId = cleanString(checkoutAttemptId, 120);
  if (!cleanToken || !cleanCheckoutAttemptId) throw verificationError("Please verify your email before continuing to payment.", 401);

  const tokenHash = hashValue(cleanToken);
  const doc = await db.collection("orderEmailVerifications").findOne({
    email: normalizedEmail,
    checkoutAttemptId: cleanCheckoutAttemptId,
    verificationTokenHash: tokenHash,
    usedAt: { $exists: true },
    supersededAt: { $exists: false },
    tokenExpiresAt: { $gt: new Date() },
  });

  if (!doc) throw verificationError("Please verify your email before continuing to payment.", 401);
  return { email: normalizedEmail, checkoutAttemptId: cleanCheckoutAttemptId, verificationId: doc._id };
}
