import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "../database.js";
import { createCustomerAuth } from "../customerAuth.js";

const VISITOR_PATTERN = /^[a-f0-9]{64}$/;
const CONVERSATION_PATTERN = /^[a-f0-9-]{36}$/i;
const MAX_TITLE = 120;
const MAX_MESSAGES = 20;

const hash = value => createHash("sha256").update(value).digest("hex");
const cleanText = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

function validConversationId(value) { return typeof value === "string" && CONVERSATION_PATTERN.test(value); }
function visitorHash(value) { return VISITOR_PATTERN.test(value || "") ? hash(value) : null; }
function bearer(value) {
  const token = typeof value === "string" ? value.replace(/^Bearer\s+/i, "").trim() : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function displayContent(value) {
  const marker = "Visitor message:\n";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length).trim() : value;
}

function statusError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
async function persist(operation, task) {
  try { return await task(); }
  catch { throw Object.assign(new Error("Conversation persistence failed"), { code: "conversation_persistence", persistenceCode: operation }); }
}

export async function ensureAiConversationIndexes(db) {
  await db.collection("aiConversations").createIndex({ customerId: 1, updatedAt: -1 });
  await db.collection("aiConversations").createIndex({ visitorHash: 1, updatedAt: -1 });
  await db.collection("aiConversationMessages").createIndex({ conversationId: 1, createdAt: 1 });
  await db.collection("aiConversationMessages").createIndex({ conversationId: 1, clientMessageId: 1 }, { unique: true });
}

export function createAiConversationStore({ env = process.env, database = () => getDatabase(env), customerAuth } = {}) {
  const auth = customerAuth || createCustomerAuth({ database, env });

  async function owner({ authorization, visitorToken }) {
    const customer = await auth.session(bearer(authorization));
    return { customerId: customer?.id || null, visitorHash: visitorHash(visitorToken) };
  }

  async function authorize({ conversationId, authorization, visitorToken, allowMissing = true }) {
    const identity = await owner({ authorization, visitorToken });
    if (!identity.customerId && !identity.visitorHash) throw statusError("Conversation access requires a session.", 401);
    if (!validConversationId(conversationId)) {
      if (!allowMissing) throw statusError("Conversation not found.", 404);
      return { ...identity, conversation: null };
    }
    const db = await persist("database", () => database());
    await persist("indexes", () => ensureAiConversationIndexes(db));
    const conversation = await db.collection("aiConversations").findOne({ _id: conversationId });
    if (!conversation) {
      if (!allowMissing) throw statusError("Conversation not found.", 404);
      return { ...identity, conversation: null };
    }
    const matchesCustomer = identity.customerId && conversation.customerId === identity.customerId;
    const matchesVisitor = !conversation.customerId && identity.visitorHash && conversation.visitorHash === identity.visitorHash;
    if (!matchesCustomer && !matchesVisitor) throw statusError("Conversation not found.", 404);
    return { ...identity, conversation };
  }

  async function saveCompleted({ conversationId, authorization, visitorToken, source, messages, assistantText, card }) {
    if (!validConversationId(conversationId) || !Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw statusError("Invalid conversation.", 400);
    const access = await authorize({ conversationId, authorization, visitorToken });
    const turns = messages.filter(message => message?.role === "user" || message?.role === "assistant");
    const lastUser = [...turns].reverse().find(message => message.role === "user");
    const cleanAssistant = cleanText(assistantText, 12000);
    if (!lastUser || !cleanAssistant) throw statusError("Invalid conversation message.", 400);
    const db = await database();
    await ensureAiConversationIndexes(db);
    const now = new Date();
    const firstUser = turns.find(message => message.role === "user");
    const title = cleanText(displayContent(firstUser?.content || "Website idea"), MAX_TITLE) || "Website idea";
    const base = {
      _id: conversationId,
      source: source === "what-we-build" ? source : null,
      createdAt: now,
      ...(!access.customerId ? { visitorHash: access.visitorHash } : {}),
    };
    if (access.conversation?.customerId && access.conversation.customerId !== access.customerId) throw statusError("Conversation not found.", 404);
    await persist("conversation", () => db.collection("aiConversations").updateOne(
      { _id: conversationId },
      {
        $setOnInsert: base,
        $set: { updatedAt: now, title, ...(access.customerId ? { customerId: access.customerId } : {}) },
        ...(access.customerId && access.conversation?.visitorHash ? { $unset: { visitorHash: "" } } : {}),
      },
      { upsert: true },
    ));

    for (let index = 0; index < turns.length; index++) {
      const message = turns[index];
      const precedingUser = [...turns.slice(0, index)].reverse().find(item => item.role === "user");
      const clientMessageId = message.role === "assistant" && precedingUser
        ? `${cleanText(precedingUser.id, 120) || hash(precedingUser.content)}:assistant`
        : cleanText(message.id, 120) || hash(`${message.role}:${message.content}`);
      const content = cleanText(displayContent(message.content), message.role === "user" ? 4000 : 12000);
      if (!content && !message.attachments?.length) continue;
      await persist("message", () => db.collection("aiConversationMessages").updateOne(
        { conversationId, clientMessageId },
        { $setOnInsert: { _id: randomUUID(), conversationId, clientMessageId, role: message.role, content, attachments: message.attachments || [], createdAt: now } },
        { upsert: true },
      ));
    }
    const assistantId = `${cleanText(lastUser.id, 120) || hash(lastUser.content)}:assistant`;
    await persist("assistant", () => db.collection("aiConversationMessages").updateOne(
      { conversationId, clientMessageId: assistantId },
      { $set: { role: "assistant", content: card ? "" : cleanAssistant, card: card || null, updatedAt: now }, $setOnInsert: { _id: randomUUID(), conversationId, clientMessageId: assistantId, createdAt: now } },
      { upsert: true },
    ));
    const messageCount = await persist("count", () => db.collection("aiConversationMessages").countDocuments({ conversationId }));
    await persist("conversation_count", () => db.collection("aiConversations").updateOne({ _id: conversationId }, { $set: { updatedAt: now, messageCount } }));
    return { conversationId };
  }

  async function listForCustomer({ authorization, visitorToken }) {
    const identity = await owner({ authorization, visitorToken });
    if (!identity.customerId) throw statusError("Authentication required.", 401);
    const db = await database();
    await ensureAiConversationIndexes(db);

    // A guest conversation is claimable only through the same visitor token
    // that created it. Claim it before listing so the account page can show
    // the chat immediately after OAuth or email sign-in, even if the user
    // has not opened the conversation URL first.
    if (identity.visitorHash) {
      const guestRows = await db.collection("aiConversations")
        .find({ customerId: { $exists: false }, visitorHash: identity.visitorHash })
        .toArray();
      await Promise.all(guestRows.map(row => db.collection("aiConversations").updateOne(
        { _id: row._id, customerId: { $exists: false }, visitorHash: identity.visitorHash },
        { $set: { customerId: identity.customerId }, $unset: { visitorHash: "" } },
      )));
    }
    const rows = await db.collection("aiConversations").find({ customerId: identity.customerId, messageCount: { $gt: 0 } }).sort({ updatedAt: -1 }).limit(100).toArray();
    return rows.map(row => ({ id: row._id, title: row.title, source: row.source || null, messageCount: row.messageCount || 0, createdAt: row.createdAt?.toISOString?.() || null, updatedAt: row.updatedAt?.toISOString?.() || null }));
  }

  async function getForUser({ conversationId, authorization, visitorToken }) {
    const access = await authorize({ conversationId, authorization, visitorToken, allowMissing: false });
    const db = await database();
    if (access.customerId && access.conversation.visitorHash && access.visitorHash === access.conversation.visitorHash) {
      await db.collection("aiConversations").updateOne(
        { _id: conversationId, customerId: { $exists: false }, visitorHash: access.visitorHash },
        { $set: { customerId: access.customerId }, $unset: { visitorHash: "" } },
      );
    }
    const messages = await db.collection("aiConversationMessages").find({ conversationId }).sort({ createdAt: 1 }).limit(MAX_MESSAGES * 2).toArray();
    return {
      id: access.conversation._id,
      title: access.conversation.title,
      source: access.conversation.source || null,
      messages: messages.map(message => ({ id: message.clientMessageId, role: message.role, content: message.content, attachments: message.attachments || [], card: message.card || null, complete: true })),
      createdAt: access.conversation.createdAt?.toISOString?.() || null,
      updatedAt: access.conversation.updatedAt?.toISOString?.() || null,
    };
  }

  return { authorize, saveCompleted, listForCustomer, getForUser };
}

export function createAiConversationRoute(env = process.env, options = {}) {
  const store = options.store || createAiConversationStore({ env, database: options.database || (() => getDatabase(env)) });
  const origins = new Set(["https://bluemind-web-service.vercel.app", "https://bluemindwebservice.com", "https://www.bluemindwebservice.com"]);
  if (env.NODE_ENV !== "production") origins.add("http://localhost:3199");
  return async (req, res, pathname) => {
    const reply = (status, body) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json"); res.writeHead(status); res.end(JSON.stringify(body)); };
    if (!origins.has(req.headers.origin)) return reply(403, { code: "forbidden" });
    const conversationId = pathname.slice("/api/ai/conversations/".length).replace(/\/+$/, "");
    const authorization = req.headers.authorization;
    const visitorToken = req.headers["x-ai-visitor-token"];
    try {
      if (pathname === "/api/ai/conversations" && req.method === "GET") return reply(200, { conversations: await store.listForCustomer({ authorization, visitorToken }) });
      if (pathname === "/api/ai/conversations" || !validConversationId(conversationId)) return reply(404, { code: "missing" });
      if (req.method !== "GET") return reply(405, { code: "method" });
      return reply(200, { conversation: await store.getForUser({ conversationId, authorization, visitorToken }) });
    } catch (error) { return reply(error?.statusCode || 503, { code: error?.statusCode === 401 ? "credentials" : error?.statusCode === 404 ? "missing" : "unavailable" }); }
  };
}
