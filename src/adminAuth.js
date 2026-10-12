import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const ADMIN_COOKIE_NAME = "bluemind_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const ADMIN_EMPLOYEES = [
  { employeeId: "M", displayName: "Mohmed", access: "admin", title: "Admin" },
  { employeeId: "R", displayName: "Rokaia", access: "admin", title: "Admin" },
];

export const WORKSPACE_EMPLOYEES = [
  {
    employeeId: "AHMED",
    displayName: "Ahmed",
    email: "750@gmail.com",
    access: "employee",
    title: "iOS Developer",
    passwordHashEnv: "WORKSPACE_AHMED_PASSWORD_HASH",
  },
  {
    employeeId: "AMMAR",
    displayName: "Ammar",
    email: "ammar@bluemindwebservice.com",
    access: "employee",
    title: "UI/UX Designer",
    passwordHashEnv: "WORKSPACE_AMMAR_PASSWORD_HASH",
  },
  {
    employeeId: "PATRICK",
    displayName: "Patrick Jane",
    email: "patrick@bluemindwebservice.com",
    access: "employee",
    title: "Android Developer",
    passwordHashEnv: "WORKSPACE_PATRICK_PASSWORD_HASH",
  },
];

export function getAdminEmployee(employeeId) {
  return ADMIN_EMPLOYEES.find(employee => employee.employeeId === employeeId) || null;
}

export function getWorkspaceEmployee(employeeId) {
  return WORKSPACE_EMPLOYEES.find(employee => employee.employeeId === employeeId) || null;
}

export function getWorkspaceIdentity(env = process.env, employeeId) {
  const admin = getAdminEmployee(employeeId);
  if (admin) return buildAdminIdentity(env, admin.employeeId);

  const employee = getWorkspaceEmployee(employeeId);
  if (!employee) return null;
  return {
    access: "employee",
    email: employee.email,
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    title: employee.title,
  };
}

export function buildAdminIdentity(env = process.env, employeeId) {
  const employee = getAdminEmployee(employeeId);
  if (!employee) return null;
  return {
    access: "admin",
    email: String(env.ADMIN_EMAIL || "").trim().toLowerCase(),
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    title: employee.title,
  };
}

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
    { ...ADMIN_EMPLOYEES[0], passwordHash: String(env.ADMIN_M_PASSWORD_HASH || "").trim() },
    { ...ADMIN_EMPLOYEES[1], passwordHash: String(env.ADMIN_R_PASSWORD_HASH || "").trim() },
  ].filter(employee => employee.passwordHash);

  if (!email || employees.length < 2) return null;
  return { email, employees };
}

export function getWorkspaceConfig(env = process.env) {
  return WORKSPACE_EMPLOYEES.map(employee => ({
    ...employee,
    passwordHash: String(env[employee.passwordHashEnv] || "").trim(),
  })).filter(employee => employee.passwordHash);
}

export async function verifyAdminCredentials(env, email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (typeof password !== "string" || !password) return null;

  const config = getAdminConfig(env);
  if (config && normalizedEmail === config.email) {
    for (const employee of config.employees) {
      if (await bcrypt.compare(password, employee.passwordHash)) {
        return buildAdminIdentity(env, employee.employeeId);
      }
    }
  }

  for (const employee of getWorkspaceConfig(env)) {
    if (normalizedEmail !== employee.email.toLowerCase()) continue;
    if (await bcrypt.compare(password, employee.passwordHash)) {
      return getWorkspaceIdentity(env, employee.employeeId);
    }
  }

  return null;
}

export function createAdminSession(env = process.env, identityOrEmployeeId) {
  const secret = getSecret(env);
  const identity = typeof identityOrEmployeeId === "string"
    ? buildAdminIdentity(env, identityOrEmployeeId)
    : identityOrEmployeeId;
  if (!identity || !["admin", "employee"].includes(identity.access)) {
    throw new Error("Invalid workspace identity");
  }
  if (identity.access === "admin" && !getAdminEmployee(identity.employeeId)) {
    throw new Error("Invalid admin employee identity");
  }
  if (identity.access === "employee" && !getWorkspaceEmployee(identity.employeeId)) {
    throw new Error("Invalid workspace employee identity");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    role: identity.access,
    employeeId: identity.employeeId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyWorkspaceSession(token, env = process.env) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expected = sign(payload, getSecret(env));
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(actual, expectedBuffer)) return false;

  try {
    const session = JSON.parse(decodeBase64url(payload));
    if (!["admin", "employee"].includes(session.role)) return false;
    if (Number(session.exp) <= Math.floor(Date.now() / 1000)) return false;
    const identity = getWorkspaceIdentity(env, session.employeeId);
    if (!identity || identity.access !== session.role) return false;
    return identity;
  } catch {
    return false;
  }
}

export function verifyAdminSession(token, env = process.env) {
  const session = verifyWorkspaceSession(token, env);
  if (!session || session.access !== "admin") return false;
  return session;
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

export function isWorkspaceRequest(req, env = process.env) {
  try {
    return verifyWorkspaceSession(getCookie(req, ADMIN_COOKIE_NAME), env);
  } catch {
    return false;
  }
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
