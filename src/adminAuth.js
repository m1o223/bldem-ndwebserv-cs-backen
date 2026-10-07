import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const ADMIN_COOKIE_NAME = "bluemind_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getSecret(env) {
  const secret = env.ADMIN_SESSION_SECRET;
  if (!secret || typeof secret !== "string" || secret.trim().length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be configured with at least 32 characters");
  }
  return secret.trim();
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function getAdminConfig(env = process.env) {
  const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const employees = [
    { employeeId: "M", passwordHash: String(env.ADMIN_M_PASSWORD_HASH || "").trim() },
    { employeeId: "R", passwordHash: String(env.ADMIN_R_PASSWORD_HASH || "").trim() },
  ].filter(employee => employee.passwordHash);

  if (!email || employees.length < 2) return null;
  return { email, employees };
}

export async function verifyAdminCredentials(env, email, password) {
  const config = getAdminConfig(env);
  if (!config) return null;
  if (String(email || "").trim().toLowerCase() !== config.email) return null;
  if (typeof password !== "string" || !password) return null;

  for (const employee of config.employees) {
    if (await bcrypt.compare(password, employee.passwordHash)) {
      return { email: config.email, employeeId: employee.employeeId };
    }
  }

  return null;
}

export function createAdminSession(env = process.env, employeeId) {
  const secret = getSecret(env);
  if (!["M", "R"].includes(employeeId)) throw new Error("Invalid admin employee identity");
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    role: "admin",
    employeeId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAdminSession(token, env = process.env) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expected = sign(payload, getSecret(env));
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(actual, expectedBuffer)) return false;

  try {
    const session = JSON.parse(decodeBase64url(payload));
    if (session.role !== "admin") return false;
    if (!["M", "R"].includes(session.employeeId)) return false;
    if (Number(session.exp) <= Math.floor(Date.now() / 1000)) return false;
    return { role: "admin", employeeId: session.employeeId };
  } catch {
    return false;
  }
}

export function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return "";
  const cookies = cookieHeader.split(";").map(part => part.trim());
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0) continue;
    if (cookie.slice(0, index) === name) return decodeURIComponent(cookie.slice(index + 1));
  }
  return "";
}

export function isAdminRequest(req, env = process.env) {
  try {
    return verifyAdminSession(getCookie(req, ADMIN_COOKIE_NAME), env);
  } catch {
    return false;
  }
}

export function buildAdminSessionCookie(token, env = process.env) {
  const secure = env.NODE_ENV === "production" ? " Secure;" : "";
  const sameSite = env.NODE_ENV === "production" ? " SameSite=None;" : " SameSite=Lax;";
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure}${sameSite} Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildAdminLogoutCookie(env = process.env) {
  const secure = env.NODE_ENV === "production" ? " Secure;" : "";
  const sameSite = env.NODE_ENV === "production" ? " SameSite=None;" : " SameSite=Lax;";
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly;${secure}${sameSite} Max-Age=0`;
}
