import { randomUUID } from "node:crypto";
import { validateContactSubmission } from "./validation.js";
import { sendFormNotification } from "./email.js";

export const customerTypes = [null, "private", "company"];
export const preferenceKeys = ["project", "team", "billing", "email"];
export const projectSteps = ["idea", "review", "direction", "development", "testing", "finalReview", "delivery"];
const welcomeMessages = Object.freeze({
  en: "Welcome to BlueMind Web Service. How can I help you today?",
  sv: "Välkommen till BlueMind Web Service. Hur kan jag hjälpa dig idag?",
  ar: "مرحباً بك في BlueMind Web Service. كيف يمكنني مساعدتك اليوم?",
});
const text = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const messageText = value => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, 4000) : "";
export function customerProfile(account) {
  return {
    fullName: text(account.fullName || (account.displayName !== account.email ? account.displayName : ""), 160),
    customerType: customerTypes.includes(account.customerType) ? account.customerType || null : null,
    companyName: text(account.companyName, 180), companyNumber: text(account.companyNumber, 80),
    preferences: Object.fromEntries(preferenceKeys.map(key => [key, account.preferences?.[key] === true])),
    // Providers are never linked by matching email addresses alone.
    loginMethods: [...(account.passwordHash ? ["email"] : []), ...(account.googleSubject ? ["google"] : [])],
  };
}
function projectView(project) {
  if (!project) return null;
  const steps = projectSteps.map(key => ({ key, status: ["completed", "in_progress", "not_started"].includes(project.steps?.[key]) ? project.steps[key] : null }));
  const complete = steps.filter(step => step.status === "completed").length;
  const allKnown = steps.every(step => step.status !== null);
  const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    name: text(project.name), description: text(project.description, 4000), type: text(project.type),
    orderNumber: text(project.orderNumber, 100), startedAt: date(project.startedAt), updatedAt: date(project.updatedAt),
    status: text(project.status, 100), steps, progress: allKnown ? Math.round(complete / projectSteps.length * 100) : null, remaining: allKnown ? projectSteps.length - complete : null,
    currency: /^[A-Z]{3}$/.test(project.currency || "") ? project.currency : null,
    totalMinor: amount(project.totalMinor), paidMinor: amount(project.paidMinor), remainingMinor: amount(project.remainingMinor),
    timeline: Array.isArray(project.timeline) ? project.timeline.slice(-30).map(item => ({ text: text(item.text, 1000), date: date(item.date) })) : [],
  };
}
export async function customerOverview(db, user) {
  const account = await db.collection("customerAccounts").findOne({ _id: user.id, enabled: true });
  if (!account) return null;
  const project = await db.collection("customerProjects").findOne({ customerId: user.id, current: true });
  const notifications = await db.collection("customerNotifications").find({ customerId: user.id }).sort({ createdAt: -1 }).limit(20).toArray();
  return { profile: customerProfile(account), project: projectView(project), notifications: notifications.map(item => ({ id: String(item._id), text: text(item.text, 1000), createdAt: date(item.createdAt), read: item.read === true })) };
}

export async function ensureCustomerMessageIndexes(db) {
  await db.collection("customerTeamMessages").createIndex({ customerId: 1, createdAt: 1 });
  await db.collection("customerTeamMessages").createIndex({ customerId: 1, clientMessageId: 1 }, { unique: true, sparse: true });
  await db.collection("customerTeamMessages").createIndex({ customerId: 1, systemKey: 1 }, { unique: true, sparse: true });
}

function serializeCustomerMessage(message, sender = "team") {
  return {
    id: String(message._id),
    sender: message.sender === "customer" ? "customer" : sender,
    body: messageText(message.body),
    createdAt: date(message.createdAt),
    orderNumber: text(message.orderNumber, 100) || null,
    read: message.read === true,
  };
}

export async function ensureCustomerWelcome(db, user, locale) {
  const account = await db.collection("customerAccounts").findOne({ _id: user.id, enabled: true });
  if (!account) return null;
  await ensureCustomerMessageIndexes(db);
  const existing = await db.collection("customerTeamMessages").findOne({ customerId: user.id, systemKey: "welcome" });
  if (existing) return serializeCustomerMessage(existing);
  const message = {
    _id: randomUUID(), customerId: user.id, sender: "team", systemKey: "welcome",
    body: welcomeMessages[locale] || welcomeMessages.en, orderNumber: null, read: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
  try {
    await db.collection("customerTeamMessages").insertOne(message);
    return serializeCustomerMessage(message);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const concurrent = await db.collection("customerTeamMessages").findOne({ customerId: user.id, systemKey: "welcome" });
    return concurrent ? serializeCustomerMessage(concurrent) : null;
  }
}

export async function customerMessages(db, user) {
  const account = await db.collection("customerAccounts").findOne({ _id: user.id, enabled: true });
  if (!account) return null;
  await ensureCustomerMessageIndexes(db);
  const [notifications, messages] = await Promise.all([
    db.collection("customerNotifications").find({ customerId: user.id }).sort({ createdAt: 1 }).limit(100).toArray(),
    db.collection("customerTeamMessages").find({ customerId: user.id }).sort({ createdAt: 1 }).limit(100).toArray(),
  ]);
  const combined = [
    ...notifications.map(item => serializeCustomerMessage({ ...item, _id: `notification:${String(item._id)}`, body: item.text, sender: "team" })),
    ...messages.map(item => serializeCustomerMessage(item)),
  ].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
  return { messages: combined, unread: combined.filter(item => item.sender === "team" && !item.read).length };
}

export async function markCustomerMessagesRead(db, user) {
  const now = new Date();
  const [notifications, messages] = await Promise.all([
    db.collection("customerNotifications").find({ customerId: user.id }).toArray(),
    db.collection("customerTeamMessages").find({ customerId: user.id, sender: "team" }).toArray(),
  ]);
  await Promise.all([
    ...notifications.filter(item => item.read !== true).map(item => db.collection("customerNotifications").updateOne({ _id: item._id }, { $set: { read: true, updatedAt: now } })),
    ...messages.filter(item => item.read !== true).map(item => db.collection("customerTeamMessages").updateOne({ _id: item._id }, { $set: { read: true, updatedAt: now } })),
  ]);
  return { success: true };
}

export async function sendCustomerMessage(db, user, body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["body", "orderNumber", "clientMessageId"].includes(key))) return { status: 400, code: "invalid" };
  const cleanBody = messageText(body.body);
  const orderNumber = typeof body.orderNumber === "string" ? body.orderNumber.trim().slice(0, 100) : "";
  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 160) : "";
  if (!cleanBody || cleanBody.length > 4000 || (body.orderNumber !== undefined && typeof body.orderNumber !== "string") || (body.clientMessageId !== undefined && typeof body.clientMessageId !== "string")) return { status: 400, code: "invalid" };
  await ensureCustomerMessageIndexes(db);
  if (clientMessageId) {
    const existing = await db.collection("customerTeamMessages").findOne({ customerId: user.id, clientMessageId });
    if (existing) return { status: 200, message: serializeCustomerMessage(existing), duplicate: true };
  }
  const message = { _id: randomUUID(), customerId: user.id, sender: "customer", body: cleanBody, orderNumber: orderNumber || null, clientMessageId: clientMessageId || undefined, read: true, createdAt: new Date(), updatedAt: new Date() };
  await db.collection("customerTeamMessages").insertOne(message);
  return { status: 200, message: serializeCustomerMessage(message), duplicate: false };
}
export async function saveCustomerProfile(db, user, body) {
  if (!body || typeof body !== "object" || Object.keys(body).some(key => !["fullName", "customerType", "companyName", "companyNumber", "preferences"].includes(key))) return false;
  const values = {};
  for (const [key, maximum] of [["fullName", 160], ["companyName", 180], ["companyNumber", 80]]) {
    if (typeof body[key] !== "string" || body[key].length > maximum || /[\u0000-\u001f]/.test(body[key])) return false;
    values[key] = body[key].trim();
  }
  if (!customerTypes.includes(body.customerType)) return false;
  if (!body.preferences || Object.keys(body.preferences).length !== preferenceKeys.length || preferenceKeys.some(key => typeof body.preferences[key] !== "boolean")) return false;
  values.customerType = body.customerType;
  if (body.customerType !== "company") { values.companyName = ""; values.companyNumber = ""; }
  values.preferences = Object.fromEntries(preferenceKeys.map(key => [key, body.preferences[key]]));
  values.displayName = values.fullName || user.email;
  values.updatedAt = new Date();
  await db.collection("customerAccounts").updateOne({ _id: user.id, enabled: true }, { $set: values });
  return true;
}
export async function customerContact(db, user, body, env, notify = sendFormNotification) {
  if (!body || !customerTypes.includes(body.customerType ?? null) || typeof body.message !== "string" || body.message.length > 4000 || typeof body.name !== "string" || body.name.length > 160 || typeof body.email !== "string" || body.email.length > 254 || typeof body.orderNumber !== "string" || body.orderNumber.length > 100 || typeof body.companyName !== "string" || body.companyName.length > 180) return { status: 400, code: "invalid" };
  let doc;
  try { doc = validateContactSubmission({ ...body, company: body.customerType === "company" ? body.companyName : "", subject: body.orderNumber ? `Customer enquiry: ${body.orderNumber}` : "Customer enquiry" }); }
  catch { return { status: 400, code: "invalid" }; }
  doc = { ...doc, _id: randomUUID(), customerId: user.id, customerType: body.customerType ?? null, orderNumber: body.orderNumber, source: "customer-app" };
  await db.collection("contacts").insertOne(doc);
  // The persisted inbox entry is the receipt; email delivery is a separate outcome.
  let emailNotified = false;
  try { emailNotified = (await notify(env, "/api/contact", doc))?.sent === true; } catch { /* Retain the inbox entry even when mail is unavailable. */ }
  if (body.customerType) await db.collection("customerAccounts").updateOne({ _id: user.id, enabled: true }, { $set: { customerType: body.customerType, companyName: body.customerType === "company" ? body.companyName.trim() : "", updatedAt: new Date() } });
  return { status: 200, success: true, emailNotified };
}
