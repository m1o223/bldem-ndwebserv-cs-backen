import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  buildAdminIdentity,
  buildAdminLogoutCookie,
  buildAdminSessionCookie,
  createAdminSession,
  isAdminRequest,
  isWorkspaceRequest,
  verifyAdminCredentials,
  ADMIN_EMPLOYEES,
  getAdminEmployee,
} from "./adminAuth.js";
import { getDatabase } from "./database.js";
import { sendFormNotification, sendOrderReadyNotification } from "./email.js";
import {
  cancelCareSubscription,
  createCareStripeCheckoutSession,
  getCareCheckoutStatus,
  handleCareStripeWebhookEvent,
  listAdminCareSubscriptions,
  listCareSubscriptionsForVerifiedEmail,
} from "./careSubscriptions.js";
import { listCarePlans } from "./carePricing.js";
import { requestEmailVerification, verifyEmailCode } from "./emailVerification.js";
import {
  createClarificationRequest,
  sendClarificationRequestNotification,
  sendOrderReviewConfirmationNotification,
} from "./orderNotifications.js";
import {
  createOrderActivity,
  buildOrderSearchQuery,
  ensureOrderIndexes,
  normalizeOrderNumber,
  serializeOrder,
  validateOrderStatus,
} from "./orders.js";
import { listActiveWebsitePackages } from "./pricing.js";
import {
  constructStripeEvent,
  createStripeCheckoutSession,
  getStripeCheckoutStatus,
  handleStripeWebhookEvent,
} from "./stripePayments.js";
import { validateContactSubmission, validateQuoteSubmission, ValidationError } from "./validation.js";
import {
  ensureMessengerIndexes,
  getMessengerUnreadTotal,
  getOrCreatePrivateConversation,
  listMessengerContacts,
  listMessengerConversations,
  listMessengerMessages,
  markConversationRead,
  sendMessengerMessage,
  serializeMessengerConversation,
} from "./workspaceMessenger.js";

const BODY_LIMIT_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const PRESENCE_TIMEOUT_MS = 120_000;
const KNOWN_PRODUCTION_ORIGINS = [
  "https://bluemindwebservice.com",
  "https://www.bluemindwebservice.com",
  "https://bluemind-web-service.vercel.app",
  "https://admin-bluemindwebservise.vercel.app",
];

function parseAllowedOrigins(env) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!origins.length) throw new Error("ALLOWED_ORIGINS must be configured");
  const allowedOrigins = [...origins, ...KNOWN_PRODUCTION_ORIGINS];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid allowed origin");
    if (env.NODE_ENV === "production" && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Production origins require HTTPS");
  }
  return new Set(allowedOrigins);
}

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function createRateLimiter() {
  const buckets = new Map();
  return req => {
    const now = Date.now();
    const key = getClientKey(req);
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    current.count += 1;
    return current.count <= RATE_LIMIT_MAX;
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, limitBytes = BODY_LIMIT_BYTES * 4) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cleanAdminMessage(value, maxLength = 2400) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function ensureCollections(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name));
  for (const name of [
    "contacts",
    "quoteRequests",
    "clients",
    "projects",
    "orders",
    "adminEvents",
    "adminPresence",
    "counters",
    "paymentEvents",
    "orderEmailVerifications",
    "orderNotifications",
    "careSubscriptions",
    "careSubscriptionCheckouts",
    "careNotifications",
    "checkoutSessions",
    "workspaceTasks",
    "workspaceProjects",
    "workspaceMessages",
    "workspaceConversations",
    "workspaceMessengerMessages",
    "workspaceMeetings",
    "workspaceFiles",
    "workspaceWorkSessions",
    "workspaceCheckIns",
  ]) {
    if (!existing.has(name)) await db.createCollection(name);
  }
  await ensureOrderIndexes(db);
  await db.collection("adminPresence").createIndex({ employeeId: 1 }, { unique: true });
  await db.collection("checkoutSessions").createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
  await db.collection("checkoutSessions").createIndex({ email: 1, createdAt: -1 });
  await db.collection("careSubscriptionCheckouts").createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
  await db.collection("careSubscriptionCheckouts").createIndex({ customerEmail: 1, createdAt: -1 });
  await db.collection("careSubscriptions").createIndex({ stripeSubscriptionId: 1 }, { unique: true, sparse: true });
  await db.collection("careSubscriptions").createIndex({ customerEmail: 1, updatedAt: -1 });
  await db.collection("careSubscriptions").createIndex({ orderNumber: 1, planId: 1, testMode: 1 });
  await db.collection("careNotifications").createIndex({ subscriptionId: 1, type: 1, dedupeKey: 1 }, { unique: true });
  await db.collection("workspaceTasks").createIndex({ assigneeId: 1, status: 1, deadline: 1 });
  await db.collection("workspaceProjects").createIndex({ assigneeIds: 1, status: 1 });
  await db.collection("workspaceMessages").createIndex({ participantIds: 1, createdAt: -1 });
  await ensureMessengerIndexes(db);
  await db.collection("workspaceMeetings").createIndex({ participantIds: 1, startsAt: 1 });
  await db.collection("workspaceFiles").createIndex({ employeeIds: 1, uploadedAt: -1 });
  await db.collection("workspaceWorkSessions").createIndex({ employeeId: 1, startedAt: -1 });
  await db.collection("workspaceCheckIns").createIndex({ employeeId: 1, createdAt: -1 });
}


function serializeAdmin(env, sessionOrAdmin) {
  if (!sessionOrAdmin) return null;
  return buildAdminIdentity(env, sessionOrAdmin.employeeId);
}

function serializeWorkspaceUser(env, sessionOrUser) {
  if (!sessionOrUser) return null;
  if (sessionOrUser.access === "admin") return buildAdminIdentity(env, sessionOrUser.employeeId);
  return sessionOrUser;
}

function serializePresence(doc, now = new Date()) {
  const employee = getAdminEmployee(doc.employeeId) || doc;
  const lastSeenAt = doc.lastSeenAt instanceof Date ? doc.lastSeenAt : (doc.lastSeenAt ? new Date(doc.lastSeenAt) : null);
  const online = lastSeenAt ? now.getTime() - lastSeenAt.getTime() <= PRESENCE_TIMEOUT_MS : false;
  return {
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    online,
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
  };
}

async function updateAdminPresence(env, employeeId, { online = true } = {}) {
  const employee = getAdminEmployee(employeeId);
  if (!employee || !env.MONGODB_URI) return null;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const lastSeenAt = online ? new Date() : new Date(0);
  await db.collection("adminPresence").updateOne(
    { employeeId: employee.employeeId },
    {
      $set: {
        employeeId: employee.employeeId,
        displayName: employee.displayName,
        lastSeenAt,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return { ...employee, lastSeenAt };
}

async function getAdminPresence(env) {
  if (!env.MONGODB_URI) return ADMIN_EMPLOYEES.map(employee => serializePresence(employee));
  const db = await getDatabase(env);
  await ensureCollections(db);
  const docs = await db.collection("adminPresence").find({}).toArray();
  const byId = new Map(docs.map(doc => [doc.employeeId, doc]));
  const now = new Date();
  return ADMIN_EMPLOYEES.map(employee => serializePresence(byId.get(employee.employeeId) || employee, now));
}

const WORKSPACE_TASK_STATUSES = new Set(["To Do", "In Progress", "Waiting for Review", "Changes Requested", "Completed"]);
const WORKSPACE_PRIORITIES = new Set(["Low", "Medium", "High", "Urgent"]);
const MANAGER_RECIPIENTS = new Set(["M", "R"]);

function serializeWorkspaceDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeWorkspaceTask(task) {
  return {
    id: String(task._id || task.taskId || ""),
    taskId: task.taskId || String(task._id || ""),
    title: task.title || "Untitled task",
    description: task.description || "",
    projectName: task.projectName || "Unassigned project",
    assignedBy: task.assignedBy || "Management",
    assignedAt: serializeWorkspaceDate(task.assignedAt),
    deadline: serializeWorkspaceDate(task.deadline),
    priority: WORKSPACE_PRIORITIES.has(task.priority) ? task.priority : "Medium",
    attachedFiles: Array.isArray(task.attachedFiles) ? task.attachedFiles : [],
    referenceDesigns: Array.isArray(task.referenceDesigns) ? task.referenceDesigns : [],
    status: WORKSPACE_TASK_STATUSES.has(task.status) ? task.status : "To Do",
    progress: Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Number(task.progress))) : 0,
    githubLink: task.githubLink || "",
    comments: Array.isArray(task.comments) ? task.comments.map(comment => ({
      authorId: comment.authorId || "system",
      authorName: comment.authorName || "BlueMind Workspace",
      message: comment.message || "",
      createdAt: serializeWorkspaceDate(comment.createdAt),
    })) : [],
    submittedAt: serializeWorkspaceDate(task.submittedAt),
  };
}

function serializeWorkspaceProject(project) {
  return {
    id: String(project._id || project.projectId || ""),
    projectId: project.projectId || String(project._id || ""),
    name: project.name || "Untitled project",
    description: project.description || "",
    deadlines: Array.isArray(project.deadlines) ? project.deadlines : [],
    approvedDesigns: Array.isArray(project.approvedDesigns) ? project.approvedDesigns : [],
    files: Array.isArray(project.files) ? project.files : [],
    githubLinks: Array.isArray(project.githubLinks) ? project.githubLinks : [],
    developmentStatus: project.developmentStatus || "Not started",
    managerNotes: project.managerNotes || "",
  };
}

function serializeWorkspaceMessage(message) {
  return {
    id: String(message._id || ""),
    projectId: message.projectId || null,
    fromId: message.fromId,
    toId: message.toId,
    body: message.body || "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    readBy: Array.isArray(message.readBy) ? message.readBy : [],
    createdAt: serializeWorkspaceDate(message.createdAt),
  };
}

function serializeWorkspaceMeeting(meeting) {
  return {
    id: String(meeting._id || ""),
    purpose: meeting.purpose || "Workspace meeting",
    startsAt: serializeWorkspaceDate(meeting.startsAt),
    endsAt: serializeWorkspaceDate(meeting.endsAt),
    participants: Array.isArray(meeting.participants) ? meeting.participants : [],
    joinUrl: meeting.joinUrl || "",
    notes: meeting.notes || "",
  };
}

function serializeWorkspaceFile(file) {
  return {
    id: String(file._id || ""),
    fileName: file.fileName || "Untitled file",
    projectName: file.projectName || "",
    fileType: file.fileType || "file",
    downloadUrl: file.downloadUrl || "",
    uploadedBy: file.uploadedBy || "BlueMind Workspace",
    uploadedAt: serializeWorkspaceDate(file.uploadedAt),
  };
}

function activeWorkMilliseconds(session, now = new Date()) {
  if (!session?.startedAt) return 0;
  const ranges = Array.isArray(session.activeRanges) ? session.activeRanges : [];
  return ranges.reduce((total, range) => {
    const start = range.start ? new Date(range.start) : null;
    const end = range.end ? new Date(range.end) : now;
    if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return total;
    return total + (end.getTime() - start.getTime());
  }, 0);
}

function breakMilliseconds(session, now = new Date()) {
  const ranges = Array.isArray(session.breakRanges) ? session.breakRanges : [];
  return ranges.reduce((total, range) => {
    const start = range.start ? new Date(range.start) : null;
    const end = range.end ? new Date(range.end) : now;
    if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return total;
    return total + (end.getTime() - start.getTime());
  }, 0);
}

function serializeWorkSession(session) {
  if (!session) return null;
  const now = new Date();
  return {
    id: String(session._id || ""),
    employeeId: session.employeeId,
    status: session.status || "ended",
    currentTaskId: session.currentTaskId || "",
    startedAt: serializeWorkspaceDate(session.startedAt),
    pausedAt: serializeWorkspaceDate(session.pausedAt),
    endedAt: serializeWorkspaceDate(session.endedAt),
    activeMilliseconds: activeWorkMilliseconds(session, now),
    breakMilliseconds: breakMilliseconds(session, now),
  };
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function getTodayWorkSummary(db, employeeId) {
  const { start, end } = todayRange();
  const sessions = await db.collection("workspaceWorkSessions").find({ employeeId, startedAt: { $gte: start, $lt: end } }).toArray();
  return {
    activeMilliseconds: sessions.reduce((total, session) => total + activeWorkMilliseconds(session), 0),
    breakMilliseconds: sessions.reduce((total, session) => total + breakMilliseconds(session), 0),
    sessions: sessions.map(serializeWorkSession),
  };
}

function requireWorkspaceUser(req, res, env) {
  const session = isWorkspaceRequest(req, env);
  if (!session) {
    json(res, 401, { success: false, error: "Authentication required." });
    return null;
  }
  return session;
}

function requireEmployeeWorkspace(req, res, env) {
  const session = requireWorkspaceUser(req, res, env);
  if (!session) return null;
  if (session.access !== "employee") {
    json(res, 403, { success: false, error: "This workspace is only available to employee accounts." });
    return null;
  }
  return session;
}

function cleanWorkspaceText(value, max = 2000) {
  return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}

async function findAssignedTask(db, employeeId, taskId) {
  return await db.collection("workspaceTasks").findOne({ taskId, assigneeId: employeeId });
}

async function handleWorkspaceOverview(req, res, env) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const [tasks, projects, messages, meetings, files, workSummary] = await Promise.all([
    db.collection("workspaceTasks").find({ assigneeId: employee.employeeId }).sort({ deadline: 1 }).toArray(),
    db.collection("workspaceProjects").find({ assigneeIds: employee.employeeId }).sort({ name: 1 }).toArray(),
    db.collection("workspaceMessages").find({ participantIds: employee.employeeId }).sort({ createdAt: -1 }).limit(20).toArray(),
    db.collection("workspaceMeetings").find({ participantIds: employee.employeeId, startsAt: { $gte: new Date() } }).sort({ startsAt: 1 }).limit(5).toArray(),
    db.collection("workspaceFiles").find({ employeeIds: employee.employeeId }).sort({ uploadedAt: -1 }).limit(20).toArray(),
    getTodayWorkSummary(db, employee.employeeId),
  ]);
  const serializedTasks = tasks.map(serializeWorkspaceTask);
  return json(res, 200, {
    success: true,
    employee,
    summary: {
      todayAssignedTasks: serializedTasks.filter(task => task.status === "To Do").length,
      tasksInProgress: serializedTasks.filter(task => task.status === "In Progress").length,
      waitingForReview: serializedTasks.filter(task => task.status === "Waiting for Review").length,
      activeProjects: projects.length,
      upcomingDeadlines: serializedTasks.filter(task => task.deadline && new Date(task.deadline) >= new Date()).slice(0, 5),
      unreadMessages: await getMessengerUnreadTotal({ db, currentUserId: employee.employeeId }),
      nextMeeting: meetings[0] ? serializeWorkspaceMeeting(meetings[0]) : null,
      todayWork: workSummary,
    },
    tasks: serializedTasks,
    projects: projects.map(serializeWorkspaceProject),
    messages: messages.map(serializeWorkspaceMessage),
    meetings: meetings.map(serializeWorkspaceMeeting),
    files: files.map(serializeWorkspaceFile),
  });
}

async function handleWorkspaceTasks(req, res, env) {
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  if (req.method === "GET") {
    const tasks = await db.collection("workspaceTasks").find({ assigneeId: employee.employeeId }).sort({ deadline: 1 }).toArray();
    return json(res, 200, { success: true, tasks: tasks.map(serializeWorkspaceTask) });
  }
  res.setHeader("Allow", "GET, OPTIONS");
  return json(res, 405, { success: false, error: "Method not allowed" });
}

async function handleWorkspaceTaskDetail(req, res, env, taskId) {
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const task = await findAssignedTask(db, employee.employeeId, taskId);
  if (!task) return json(res, 404, { success: false, error: "Task not found." });
  if (req.method === "GET") return json(res, 200, { success: true, task: serializeWorkspaceTask(task) });
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "GET, PATCH, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const action = String(body?.action || "").trim();
  const now = new Date();
  const update = { updatedAt: now };
  if (action === "start") update.status = "In Progress";
  else if (action === "progress") update.progress = Math.max(0, Math.min(100, Number(body?.progress || 0)));
  else if (action === "comment") {
    const message = cleanWorkspaceText(body?.message, 1200);
    if (!message) return json(res, 400, { success: false, error: "Comment is required." });
    await db.collection("workspaceTasks").updateOne({ _id: task._id }, { $push: { comments: { authorId: employee.employeeId, authorName: employee.displayName, message, createdAt: now } }, $set: { updatedAt: now } });
    const updated = await db.collection("workspaceTasks").findOne({ _id: task._id });
    return json(res, 200, { success: true, task: serializeWorkspaceTask(updated) });
  } else if (action === "submit") {
    update.status = "Waiting for Review";
    update.submittedAt = now;
    update.githubLink = cleanWorkspaceText(body?.githubLink, 400);
  } else {
    return json(res, 400, { success: false, error: "Unsupported task action." });
  }
  await db.collection("workspaceTasks").updateOne({ _id: task._id }, { $set: update });
  const updated = await db.collection("workspaceTasks").findOne({ _id: task._id });
  return json(res, 200, { success: true, task: serializeWorkspaceTask(updated) });
}

async function handleWorkspaceCollection(req, res, env, collectionName, filter, serializer, sort = {}) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const docs = await db.collection(collectionName).find(filter(employee)).sort(sort).toArray();
  return json(res, 200, { success: true, items: docs.map(serializer) });
}

async function handleMessengerContacts(req, res, env) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const user = requireWorkspaceUser(req, res, env);
  if (!user) return;
  return json(res, 200, { success: true, contacts: await listMessengerContacts({ env, currentUserId: user.employeeId }) });
}

async function handleMessengerConversations(req, res, env) {
  const user = requireWorkspaceUser(req, res, env);
  if (!user) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  if (req.method === "GET") {
    return json(res, 200, { success: true, conversations: await listMessengerConversations({ db, env, currentUserId: user.employeeId }) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const conversation = await getOrCreatePrivateConversation({ db, env, currentUserId: user.employeeId, contactId: body?.contactId || body?.participantId });
  const contacts = await listMessengerContacts({ env, currentUserId: user.employeeId });
  const usersById = new Map(contacts.map(contact => [contact.employeeId, contact]));
  return json(res, 201, { success: true, conversation: serializeMessengerConversation(conversation, user.employeeId, usersById, 0) });
}

async function handleMessengerConversationMessages(req, res, env, conversationId, url) {
  const user = requireWorkspaceUser(req, res, env);
  if (!user) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  if (req.method === "GET") {
    const messages = await listMessengerMessages({
      db,
      conversationId,
      currentUserId: user.employeeId,
      limit: url.searchParams.get("limit"),
      before: url.searchParams.get("before"),
    });
    return json(res, 200, { success: true, messages });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const result = await sendMessengerMessage({
    db,
    conversationId,
    currentUserId: user.employeeId,
    body: body?.body || body?.message,
    clientMessageId: body?.clientMessageId,
  });
  return json(res, result.duplicate ? 200 : 201, { success: true, ...result });
}

async function handleMessengerConversationRead(req, res, env, conversationId) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const user = requireWorkspaceUser(req, res, env);
  if (!user) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const result = await markConversationRead({ db, conversationId, currentUserId: user.employeeId });
  return json(res, 200, { success: true, ...result, unreadTotal: await getMessengerUnreadTotal({ db, currentUserId: user.employeeId }) });
}
async function handleWorkspaceMessages(req, res, env) {
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  if (req.method === "GET") {
    const messages = await db.collection("workspaceMessages").find({ participantIds: employee.employeeId }).sort({ createdAt: -1 }).limit(50).toArray();
    return json(res, 200, { success: true, messages: messages.map(serializeWorkspaceMessage) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const toId = String(body?.toId || "M").trim().toUpperCase();
  const message = cleanWorkspaceText(body?.message, 2000);
  if (!MANAGER_RECIPIENTS.has(toId)) return json(res, 403, { success: false, error: "Messages can only be sent to authorized management." });
  if (!message) return json(res, 400, { success: false, error: "Message is required." });
  const doc = { participantIds: [employee.employeeId, toId], fromId: employee.employeeId, toId, body: message, projectId: cleanWorkspaceText(body?.projectId, 120) || null, attachments: [], readBy: [employee.employeeId], createdAt: new Date() };
  const result = await db.collection("workspaceMessages").insertOne(doc);
  return json(res, 201, { success: true, message: serializeWorkspaceMessage({ ...doc, _id: result.insertedId }) });
}

async function handleWorkspaceWorkSession(req, res, env) {
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const activeFilter = { employeeId: employee.employeeId, endedAt: null };
  if (req.method === "GET") {
    const active = await db.collection("workspaceWorkSessions").findOne(activeFilter, { sort: { startedAt: -1 } });
    return json(res, 200, { success: true, session: serializeWorkSession(active), today: await getTodayWorkSummary(db, employee.employeeId) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const action = String(body?.action || "").trim();
  const now = new Date();
  const active = await db.collection("workspaceWorkSessions").findOne(activeFilter, { sort: { startedAt: -1 } });
  if (action === "start") {
    if (active) return json(res, 409, { success: false, error: "A work session is already active." });
    const doc = { employeeId: employee.employeeId, status: "active", currentTaskId: cleanWorkspaceText(body?.currentTaskId, 120), startedAt: now, endedAt: null, activeRanges: [{ start: now, end: null }], breakRanges: [] };
    const result = await db.collection("workspaceWorkSessions").insertOne(doc);
    return json(res, 201, { success: true, session: serializeWorkSession({ ...doc, _id: result.insertedId }), today: await getTodayWorkSummary(db, employee.employeeId) });
  }
  if (!active) return json(res, 404, { success: false, error: "No active work session found." });
  if (action === "pause") {
    if (active.status === "paused") return json(res, 200, { success: true, session: serializeWorkSession(active), today: await getTodayWorkSummary(db, employee.employeeId) });
    await db.collection("workspaceWorkSessions").updateOne({ _id: active._id }, { $set: { status: "paused", pausedAt: now, "activeRanges.$[range].end": now }, $push: { breakRanges: { start: now, end: null } } }, { arrayFilters: [{ "range.end": null }] });
  } else if (action === "resume") {
    if (active.status !== "paused") return json(res, 400, { success: false, error: "The current session is not paused." });
    await db.collection("workspaceWorkSessions").updateOne({ _id: active._id }, { $set: { status: "active", pausedAt: null, "breakRanges.$[range].end": now }, $push: { activeRanges: { start: now, end: null } } }, { arrayFilters: [{ "range.end": null }] });
  } else if (action === "end") {
    const set = { status: "ended", endedAt: now };
    if (active.status === "paused") set["breakRanges.$[range].end"] = now;
    else set["activeRanges.$[range].end"] = now;
    await db.collection("workspaceWorkSessions").updateOne({ _id: active._id }, { $set: set }, { arrayFilters: [{ "range.end": null }] });
  } else {
    return json(res, 400, { success: false, error: "Unsupported work session action." });
  }
  const updated = await db.collection("workspaceWorkSessions").findOne({ _id: active._id });
  return json(res, 200, { success: true, session: updated?.endedAt ? null : serializeWorkSession(updated), today: await getTodayWorkSummary(db, employee.employeeId) });
}

async function handleWorkspaceCheckIns(req, res, env) {
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  if (req.method === "GET") {
    const checkIns = await db.collection("workspaceCheckIns").find({ employeeId: employee.employeeId }).sort({ createdAt: -1 }).limit(20).toArray();
    return json(res, 200, { success: true, checkIns: checkIns.map(item => ({ id: String(item._id), completed: item.completed || "", workingOn: item.workingOn || "", blockers: item.blockers || "", createdAt: serializeWorkspaceDate(item.createdAt) })) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const body = await readJsonBody(req);
  const doc = { employeeId: employee.employeeId, completed: cleanWorkspaceText(body?.completed, 1000), workingOn: cleanWorkspaceText(body?.workingOn, 1000), blockers: cleanWorkspaceText(body?.blockers, 1000), createdAt: new Date() };
  if (!doc.completed && !doc.workingOn && !doc.blockers) return json(res, 400, { success: false, error: "Please add a progress update before sending." });
  const result = await db.collection("workspaceCheckIns").insertOne(doc);
  return json(res, 201, { success: true, checkIn: { id: String(result.insertedId), ...doc, createdAt: serializeWorkspaceDate(doc.createdAt) } });
}

async function handleWorkspaceProfile(req, res, env) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const employee = requireEmployeeWorkspace(req, res, env);
  if (!employee) return;
  return json(res, 200, { success: true, profile: { ...employee, preferredLanguage: "English", timezone: "Europe/Stockholm", permissions: ["workspace:read_assigned", "tasks:update_own", "messages:management", "work_sessions:self"] } });
}

async function routeWorkspaceRequest(req, res, env, route, url) {
  const taskMatch = route.match(/^\/api\/workspace\/tasks\/([^/]+)$/);
  const messengerMessagesMatch = route.match(/^\/api\/workspace\/messenger\/conversations\/([^/]+)\/messages$/);
  const messengerReadMatch = route.match(/^\/api\/workspace\/messenger\/conversations\/([^/]+)\/read$/);
  if (route === "/api/workspace/overview") return await handleWorkspaceOverview(req, res, env);
  if (route === "/api/workspace/tasks") return await handleWorkspaceTasks(req, res, env);
  if (route === "/api/workspace/messenger/contacts") return await handleMessengerContacts(req, res, env);
  if (route === "/api/workspace/messenger/conversations") return await handleMessengerConversations(req, res, env);
  if (messengerMessagesMatch) return await handleMessengerConversationMessages(req, res, env, decodeURIComponent(messengerMessagesMatch[1]), url);
  if (messengerReadMatch) return await handleMessengerConversationRead(req, res, env, decodeURIComponent(messengerReadMatch[1]));
  if (taskMatch) return await handleWorkspaceTaskDetail(req, res, env, decodeURIComponent(taskMatch[1]));
  if (route === "/api/workspace/projects") return await handleWorkspaceCollection(req, res, env, "workspaceProjects", employee => ({ assigneeIds: employee.employeeId }), serializeWorkspaceProject, { name: 1 });
  if (route === "/api/workspace/messages") return await handleWorkspaceMessages(req, res, env);
  if (route === "/api/workspace/meetings") return await handleWorkspaceCollection(req, res, env, "workspaceMeetings", employee => ({ participantIds: employee.employeeId }), serializeWorkspaceMeeting, { startsAt: 1 });
  if (route === "/api/workspace/files") return await handleWorkspaceCollection(req, res, env, "workspaceFiles", employee => ({ employeeIds: employee.employeeId }), serializeWorkspaceFile, { uploadedAt: -1 });
  if (route === "/api/workspace/work-session") return await handleWorkspaceWorkSession(req, res, env);
  if (route === "/api/workspace/check-ins") return await handleWorkspaceCheckIns(req, res, env);
  if (route === "/api/workspace/profile") return await handleWorkspaceProfile(req, res, env);
  return json(res, 404, { success: false, error: "Workspace route not found." });
}

async function handleFormRoute(req, res, env, route) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const collectionName = route === "/api/contact" ? "contacts" : "quoteRequests";
  const doc = route === "/api/contact" ? validateContactSubmission(body) : validateQuoteSubmission(body);
  const db = await getDatabase(env);
  await ensureCollections(db);
  await db.collection(collectionName).insertOne(doc);
  try {
    await sendFormNotification(env, route, doc);
  } catch (error) {
    console.error("Email notification failed", { route, message: error?.message });
  }

  return json(res, 200, {
    success: true,
    message: route === "/api/contact" ? "Message received successfully" : "Quote request received successfully"
  });
}

async function handleEmailVerificationSend(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const verification = await requestEmailVerification({ env, db, body, ip: getClientKey(req) });
  return json(res, 200, {
    success: true,
    message: "Verification code sent.",
    verification,
  });
}

async function handleEmailVerificationVerify(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const verification = await verifyEmailCode({ env, db, body });
  return json(res, 200, {
    success: true,
    message: "Email verified.",
    verification,
  });
}
async function handleStripeCheckout(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const checkout = await createStripeCheckoutSession({ env, db, body });
  return json(res, 200, { success: true, checkout });
}

async function handleStripeCheckoutStatus(req, res, env, sessionId) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const db = await getDatabase(env);
  await ensureCollections(db);
  const status = await getStripeCheckoutStatus({ db, sessionId });
  return json(res, 200, { success: true, ...status });
}

async function handleCareStripeCheckout(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const checkout = await createCareStripeCheckoutSession({ env, db, body });
  return json(res, 200, { success: true, checkout });
}

async function handleCareCheckoutStatus(req, res, env, sessionId) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const db = await getDatabase(env);
  await ensureCollections(db);
  const status = await getCareCheckoutStatus({ db, sessionId });
  return json(res, 200, { success: true, ...status });
}

async function handleCareManageList(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const result = await listCareSubscriptionsForVerifiedEmail({
    db,
    email: body?.email,
    checkoutAttemptId: body?.checkoutAttemptId,
    token: body?.emailVerificationToken,
  });
  return json(res, 200, { success: true, ...result });
}

async function handleCareCancel(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const body = await readJsonBody(req);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const result = await cancelCareSubscription({ env, db, body });
  return json(res, 200, { success: true, ...result });
}

async function handleStripeWebhook(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !signature) return json(res, 400, { success: false, error: "Missing Stripe signature" });
  const rawBody = await readRawBody(req);
  let event;
  try {
    event = constructStripeEvent(env, rawBody, signature);
  } catch (error) {
    return json(res, 400, { success: false, error: "Invalid Stripe signature" });
  }

  const db = await getDatabase(env);
  await ensureCollections(db);
  const object = event.data?.object || {};
  const isCareSubscriptionEvent = object?.metadata?.kind === "care_subscription"
    || object?.mode === "subscription"
    || event.type.startsWith("customer.subscription.")
    || (event.type.startsWith("invoice.") && object?.subscription);
  const result = isCareSubscriptionEvent
    ? await handleCareStripeWebhookEvent({ env, db, event })
    : await handleStripeWebhookEvent({ env, db, event });
  return json(res, 200, { success: true, received: true, result });
}

async function handleAdminLogin(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req);
  const user = await verifyAdminCredentials(env, body?.email, body?.password);
  if (!user) return json(res, 401, { success: false, error: "Invalid email or password." });

  const token = createAdminSession(env, user);
  if (user.access === "admin") await updateAdminPresence(env, user.employeeId);
  res.setHeader("Set-Cookie", buildAdminSessionCookie(token, env));
  return json(res, 200, {
    success: true,
    admin: user.access === "admin" ? user : null,
    employee: user,
  });
}

async function handleAdminLogout(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const session = isAdminRequest(req, env);
  if (session) await updateAdminPresence(env, session.employeeId, { online: false });
  res.setHeader("Set-Cookie", buildAdminLogoutCookie(env));
  return json(res, 200, { success: true });
}

function requireAdmin(req, res, env) {
  const session = isAdminRequest(req, env);
  if (session) return session;
  json(res, 401, { success: false, error: "Authentication required." });
  return null;
}


async function handleAdminPresence(req, res, env) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!requireAdmin(req, res, env)) return;
  const employees = await getAdminPresence(env);
  return json(res, 200, { success: true, employees });
}

async function handleAdminPresenceHeartbeat(req, res, env) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const session = requireAdmin(req, res, env);
  if (!session) return;
  await updateAdminPresence(env, session.employeeId);
  const employees = await getAdminPresence(env);
  return json(res, 200, { success: true, employee: serializeAdmin(env, session), employees });
}
async function listAdminOrders(req, res, env, url) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!requireAdmin(req, res, env)) return;

  const db = await getDatabase(env);
  await ensureCollections(db);
  const search = url.searchParams.get("search") || "";
  const orders = await db.collection("orders")
    .find(buildOrderSearchQuery(search))
    .sort({ createdAt: -1, orderNumber: -1 })
    .limit(100)
    .toArray();

  return json(res, 200, { success: true, orders: orders.map(serializeOrder) });
}

async function listAdminCare(req, res, env, url) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!requireAdmin(req, res, env)) return;
  const db = await getDatabase(env);
  await ensureCollections(db);
  const subscriptions = await listAdminCareSubscriptions({ db, search: url.searchParams.get("search") || "" });
  return json(res, 200, { success: true, subscriptions });
}

async function getAdminOrder(req, res, env, orderNumber) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const admin = requireAdmin(req, res, env);
  if (!admin) return;

  const db = await getDatabase(env);
  await ensureCollections(db);
  const collection = db.collection("orders");
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  let order = await collection.findOne({ orderNumber: normalizedOrderNumber });
  if (!order) return json(res, 404, { success: false, error: "Order not found." });

  const hasViewed = Array.isArray(order.viewedBy) && order.viewedBy.some(item => item.employeeId === admin.employeeId);
  if (!hasViewed) {
    const viewedAt = new Date();
    await collection.updateOne(
      { _id: order._id },
      {
        $push: {
          viewedBy: { employeeId: admin.employeeId, displayName: admin.displayName, viewedAt },
          activity: createOrderActivity({
            employeeId: admin.employeeId,
            displayName: admin.displayName,
            action: "order_viewed",
            message: `${admin.displayName} viewed Order ${normalizedOrderNumber}.`,
            createdAt: viewedAt,
          }),
        },
        $set: { updatedAt: viewedAt },
      },
    );
    order = await collection.findOne({ _id: order._id });
  }
  return json(res, 200, { success: true, order: serializeOrder(order) });
}

async function updateAdminOrderStatus(req, res, env, orderNumber) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const admin = requireAdmin(req, res, env);
  if (!admin) return;

  const body = await readJsonBody(req);
  const nextStatus = validateOrderStatus(body?.projectStatus);
  const db = await getDatabase(env);
  await ensureCollections(db);
  const collection = db.collection("orders");
  const current = await collection.findOne({ orderNumber: normalizeOrderNumber(orderNumber) });
  if (!current) return json(res, 404, { success: false, error: "Order not found." });

  const updatedAt = new Date();
  const activity = {
    employeeId: admin.employeeId,
    action: `changed_status_to_${nextStatus.toLowerCase().replace(/\s+/g, "_")}`,
    displayName: admin.displayName,
    message: `${admin.displayName} changed Order ${current.orderNumber} status to ${nextStatus}`,
    createdAt: updatedAt,
  };
  await collection.updateOne(
    { _id: current._id },
    {
      $set: { projectStatus: nextStatus, updatedAt },
      $push: { activity },
    },
  );
  const updated = await collection.findOne({ _id: current._id });

  let notification = { sent: false, reason: "not_applicable" };
  if (current.projectStatus !== "Ready" && nextStatus === "Ready") {
    try {
      notification = await sendOrderReadyNotification(env, updated);
      await db.collection("adminEvents").insertOne({
        type: "order_ready",
        orderNumber: updated.orderNumber,
        employeeId: admin.employeeId,
        action: activity.action,
        message: activity.message,
        displayName: admin.displayName,
        email: updated.email,
        notification,
        createdAt: new Date(),
      });
    } catch (error) {
      notification = { sent: false, reason: "failed" };
      console.error("Order ready notification failed", { orderNumber: updated.orderNumber, message: error?.message });
    }
  }

  return json(res, 200, { success: true, order: serializeOrder(updated), notification });
}

async function confirmAdminOrder(req, res, env, orderNumber) {
  if (req.method !== "POST" && req.method !== "PATCH") {
    res.setHeader("Allow", "POST, PATCH, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const admin = requireAdmin(req, res, env);
  if (!admin) return;

  const db = await getDatabase(env);
  await ensureCollections(db);
  const collection = db.collection("orders");
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  const current = await collection.findOne({ orderNumber: normalizedOrderNumber });
  if (!current) return json(res, 404, { success: false, error: "Order not found." });
  if (!current.isPaidOrder || !current.paymentEventId || !["Paid", "Deposit Paid", "Partially Paid"].includes(current.paymentStatus)) {
    return json(res, 400, { success: false, error: "Only verified paid orders can be confirmed." });
  }

  if (current.reviewStatus === "confirmed" || current.reviewedAt) {
    const notification = await sendOrderReviewConfirmationNotification(env, db, current);
    return json(res, 200, {
      success: true,
      alreadyConfirmed: true,
      order: serializeOrder(current),
      notification,
    });
  }

  const confirmedAt = new Date();
  const reviewedBy = { employeeId: admin.employeeId, displayName: admin.displayName };
  const activity = createOrderActivity({
    employeeId: admin.employeeId,
    displayName: admin.displayName,
    action: "order_confirmed",
    message: `${admin.displayName} confirmed Order ${current.orderNumber}. Order requirements reviewed and confirmed.`,
    createdAt: confirmedAt,
  });

  await collection.updateOne(
    { _id: current._id, $or: [{ reviewStatus: { $ne: "confirmed" } }, { reviewStatus: { $exists: false } }] },
    {
      $set: {
        projectStatus: "Confirmed",
        reviewStatus: "confirmed",
        reviewedAt: confirmedAt,
        reviewedBy,
        updatedAt: confirmedAt,
      },
      $push: { activity },
    },
  );

  const updated = await collection.findOne({ _id: current._id });
  const notification = await sendOrderReviewConfirmationNotification(env, db, updated);
  return json(res, 200, { success: true, order: serializeOrder(updated), notification });
}

async function requestOrderClarification(req, res, env, orderNumber) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return json(res, 415, { success: false, error: "Content-Type must be application/json" });
  }
  const admin = requireAdmin(req, res, env);
  if (!admin) return;

  const body = await readJsonBody(req);
  const message = cleanAdminMessage(body?.message);
  if (!message) return json(res, 400, { success: false, error: "Please write a clarification message." });

  const db = await getDatabase(env);
  await ensureCollections(db);
  const collection = db.collection("orders");
  const current = await collection.findOne({ orderNumber: normalizeOrderNumber(orderNumber) });
  if (!current) return json(res, 404, { success: false, error: "Order not found." });
  if (!current.isPaidOrder) return json(res, 400, { success: false, error: "Clarification can only be requested for real paid orders." });

  const clarification = createClarificationRequest({ message, employee: admin });
  const activity = createOrderActivity({
    employeeId: admin.employeeId,
    displayName: admin.displayName,
    action: "clarification_requested",
    message: `${admin.displayName} requested clarification for Order ${current.orderNumber}.`,
    createdAt: clarification.createdAt,
  });

  await collection.updateOne(
    { _id: current._id },
    {
      $set: { projectStatus: "Awaiting Clarification", updatedAt: clarification.createdAt },
      $push: { clarificationRequests: clarification, activity },
    },
  );
  const updated = await collection.findOne({ _id: current._id });
  const notification = await sendClarificationRequestNotification(env, db, updated, {
    message,
    employee: admin,
    requestId: clarification.requestId,
  });
  return json(res, 200, { success: true, order: serializeOrder(updated), notification });
}

export function createHealthServer(env = process.env) {
  const allowed = parseAllowedOrigins(env);
  const checkRateLimit = createRateLimiter();

  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    res.setHeader("Referrer-Policy", "no-referrer");

    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return json(res, 403, { success: false, error: "Origin not allowed" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname;
    const isFormRoute = route === "/api/contact" || route === "/api/quote";
    const isAdminRoute = route.startsWith("/api/admin/");
    const isWorkspaceRoute = route.startsWith("/api/workspace/");
    const isStripeWebhookRoute = route === "/api/payments/stripe/webhook";
    const isEmailVerificationRoute = route === "/api/order-email-verification/send" || route === "/api/order-email-verification/verify";
    const stripeStatusMatch = route.match(/^\/api\/payments\/stripe\/sessions\/([^/]+)$/);
    const careStatusMatch = route.match(/^\/api\/care\/stripe\/sessions\/([^/]+)$/);
    const adminOrderConfirmMatch = route.match(/^\/api\/admin\/orders\/([^/]+)\/confirm$/);
    const adminOrderClarificationMatch = route.match(/^\/api\/admin\/orders\/([^/]+)\/clarification$/);
    const adminOrderMatch = route.match(/^\/api\/admin\/orders\/([^/]+)$/);
    const allowedMethods = adminOrderConfirmMatch
      ? "POST, PATCH, OPTIONS"
      : adminOrderClarificationMatch
        ? "POST, OPTIONS"
        : route === "/api/admin/orders" || adminOrderMatch
      ? "GET, PATCH, OPTIONS"
      : isWorkspaceRoute
        ? "GET, POST, PATCH, OPTIONS"
      : (isFormRoute || route === "/api/admin/login" || route === "/api/admin/logout" || route === "/api/admin/presence/heartbeat" || route === "/api/payments/stripe/checkout" || route === "/api/care/stripe/checkout" || route === "/api/care/subscriptions/manage" || route === "/api/care/subscriptions/cancel" || isStripeWebhookRoute || isEmailVerificationRoute ? "POST, OPTIONS" : "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", allowedMethods);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (isAdminRoute || isWorkspaceRoute) res.setHeader("Access-Control-Allow-Credentials", "true");
      res.writeHead(204);
      return res.end();
    }

    if (isAdminRoute || isWorkspaceRoute) res.setHeader("Access-Control-Allow-Credentials", "true");

    try {
      if (isStripeWebhookRoute) return await handleStripeWebhook(req, res, env);

      if (route === "/api/health") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        return json(res, 200, { success: true, service: "BlueMind Web Service API", status: "healthy" });
      }

      if (route === "/api/pricing/packages") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        return json(res, 200, { success: true, packages: listActiveWebsitePackages() });
      }

      if (route === "/api/care/plans") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        return json(res, 200, { success: true, plans: listCarePlans() });
      }

      if (route === "/api/order-email-verification/send") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleEmailVerificationSend(req, res, env);
      }
      if (route === "/api/order-email-verification/verify") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleEmailVerificationVerify(req, res, env);
      }

      if (route === "/api/payments/stripe/checkout") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleStripeCheckout(req, res, env);
      }
      if (stripeStatusMatch) return await handleStripeCheckoutStatus(req, res, env, decodeURIComponent(stripeStatusMatch[1]));
      if (route === "/api/care/stripe/checkout") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleCareStripeCheckout(req, res, env);
      }
      if (careStatusMatch) return await handleCareCheckoutStatus(req, res, env, decodeURIComponent(careStatusMatch[1]));
      if (route === "/api/care/subscriptions/manage") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleCareManageList(req, res, env);
      }
      if (route === "/api/care/subscriptions/cancel") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleCareCancel(req, res, env);
      }

      if (route === "/api/admin/login") {
        if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });
        return await handleAdminLogin(req, res, env);
      }

      if (isWorkspaceRoute) return await routeWorkspaceRequest(req, res, env, route, url);

      if (route === "/api/admin/logout") return await handleAdminLogout(req, res, env);
      if (route === "/api/admin/session") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          return json(res, 405, { success: false, error: "Method not allowed" });
        }
        const session = isWorkspaceRequest(req, env);
        return json(res, 200, {
          success: true,
          authenticated: Boolean(session),
          admin: session?.access === "admin" ? serializeAdmin(env, session) : null,
          employee: session ? serializeWorkspaceUser(env, session) : null,
        });
      }
      if (route === "/api/admin/presence") return await handleAdminPresence(req, res, env);
      if (route === "/api/admin/presence/heartbeat") return await handleAdminPresenceHeartbeat(req, res, env);
      if (route === "/api/admin/orders") return await listAdminOrders(req, res, env, url);
      if (route === "/api/admin/care-subscriptions") return await listAdminCare(req, res, env, url);
      if (adminOrderConfirmMatch) return await confirmAdminOrder(req, res, env, decodeURIComponent(adminOrderConfirmMatch[1]));
      if (adminOrderClarificationMatch) return await requestOrderClarification(req, res, env, decodeURIComponent(adminOrderClarificationMatch[1]));
      if (adminOrderMatch) {
        const orderNumber = decodeURIComponent(adminOrderMatch[1]);
        return req.method === "PATCH"
          ? await updateAdminOrderStatus(req, res, env, orderNumber)
          : await getAdminOrder(req, res, env, orderNumber);
      }

      if (!isFormRoute) return json(res, 404, { success: false, error: "Not found" });
      if (!checkRateLimit(req)) return json(res, 429, { success: false, error: "Too many requests. Please try again later." });

      return await handleFormRoute(req, res, env, route);
    } catch (error) {
      if (error instanceof ValidationError) return json(res, 400, { success: false, error: "Please check the form and try again.", fields: error.fields });
      if (error?.statusCode) return json(res, error.statusCode, { success: false, error: error.message });
      console.error("Request failed", { route, message: error?.message });
      return json(res, 500, { success: false, error: "Something went wrong. Please try again later." });
    }
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const server = createHealthServer();
  server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`BlueMind API listening on port ${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
