import { ADMIN_EMPLOYEES, WORKSPACE_EMPLOYEES, buildAdminIdentity, getWorkspaceIdentity } from "./adminAuth.js";

const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 80;

function profileFor(profileById, employeeId) {
  return profileById?.get?.(employeeId) || null;
}

export function getWorkspaceDirectory(env = process.env, profileById = new Map()) {
  return [
    ...ADMIN_EMPLOYEES.map(employee => buildAdminIdentity(env, employee.employeeId)),
    ...WORKSPACE_EMPLOYEES.map(employee => getWorkspaceIdentity(env, employee.employeeId)),
  ].filter(Boolean).map(user => ({
    access: user.access,
    employeeId: user.employeeId,
    displayName: user.displayName,
    title: user.title,
    initials: initialsFor(user.displayName),
    profilePhotoUrl: profileFor(profileById, user.employeeId)?.profilePhoto?.dataUrl || "",
  }));
}

export function getMessengerUser(env = process.env, employeeId, profileById = new Map()) {
  return getWorkspaceDirectory(env, profileById).find(user => user.employeeId === employeeId) || null;
}

export function normalizeParticipantIds(ids) {
  return [...new Set(ids.map(id => String(id || "").trim().toUpperCase()).filter(Boolean))].sort();
}

export function getPrivateConversationId(userA, userB) {
  const participants = normalizeParticipantIds([userA, userB]);
  if (participants.length !== 2) return "";
  return participants.join("--");
}

export function cleanMessengerText(value, max = MAX_MESSAGE_LENGTH) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function serializeMessengerDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeMessengerUser(user) {
  if (!user) return null;
  return {
    employeeId: user.employeeId,
    displayName: user.displayName,
    title: user.title,
    access: user.access,
    initials: user.initials || initialsFor(user.displayName),
    profilePhotoUrl: user.profilePhotoUrl || "",
  };
}

export function serializeMessengerMessage(message) {
  return {
    id: String(message._id || message.messageId || ""),
    conversationId: message.conversationId,
    fromId: message.fromId,
    body: message.body || "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    readBy: Array.isArray(message.readBy) ? message.readBy : [],
    createdAt: serializeMessengerDate(message.createdAt),
    updatedAt: serializeMessengerDate(message.updatedAt),
    sendingState: "sent",
  };
}

export function serializeMessengerConversation(conversation, currentUserId, usersById = new Map(), unreadCount = 0) {
  const participantIds = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
  const otherParticipantId = participantIds.find(id => id !== currentUserId) || "";
  return {
    id: conversation.conversationId,
    conversationId: conversation.conversationId,
    type: conversation.type || "private",
    participantIds,
    contact: serializeMessengerUser(usersById.get(otherParticipantId) || { employeeId: otherParticipantId, displayName: otherParticipantId, title: "BlueMind Workspace", access: "employee" }),
    lastMessage: conversation.lastMessage ? {
      fromId: conversation.lastMessage.fromId,
      body: conversation.lastMessage.body || "",
      createdAt: serializeMessengerDate(conversation.lastMessage.createdAt),
    } : null,
    unreadCount,
    createdAt: serializeMessengerDate(conversation.createdAt),
    updatedAt: serializeMessengerDate(conversation.updatedAt),
  };
}

export async function ensureMessengerIndexes(db) {
  await db.collection("workspaceConversations").createIndex({ conversationId: 1 }, { unique: true });
  await db.collection("workspaceConversations").createIndex({ participantIds: 1, updatedAt: -1 });
  await db.collection("workspaceMessengerMessages").createIndex({ conversationId: 1, createdAt: -1 });
  await db.collection("workspaceMessengerMessages").createIndex({ participantIds: 1, createdAt: -1 });
  await db.collection("workspaceMessengerMessages").createIndex({ conversationId: 1, clientMessageId: 1 }, { unique: true, sparse: true });
}

export async function getOrCreatePrivateConversation({ db, env = process.env, currentUserId, contactId, now = new Date(), profileById = new Map() }) {
  const currentUser = getMessengerUser(env, currentUserId, profileById);
  const contact = getMessengerUser(env, contactId, profileById);
  if (!currentUser) throw statusError("Authentication required.", 401);
  if (!contact) throw statusError("Contact not found.", 404);
  if (currentUser.employeeId === contact.employeeId) throw statusError("Choose another BlueMind Workspace user.", 400);

  const participantIds = normalizeParticipantIds([currentUser.employeeId, contact.employeeId]);
  const conversationId = getPrivateConversationId(participantIds[0], participantIds[1]);
  const baseDoc = {
    conversationId,
    type: "private",
    participantIds,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("workspaceConversations").updateOne(
    { conversationId },
    { $setOnInsert: baseDoc },
    { upsert: true },
  );

  return await db.collection("workspaceConversations").findOne({ conversationId });
}

export async function listMessengerContacts({ env = process.env, currentUserId, profileById = new Map() }) {
  const users = getWorkspaceDirectory(env, profileById);
  if (!users.some(user => user.employeeId === currentUserId)) throw statusError("Authentication required.", 401);
  return users.filter(user => user.employeeId !== currentUserId).map(serializeMessengerUser);
}

export async function listMessengerConversations({ db, env = process.env, currentUserId, profileById = new Map() }) {
  const usersById = new Map(getWorkspaceDirectory(env, profileById).map(user => [user.employeeId, user]));
  if (!usersById.has(currentUserId)) throw statusError("Authentication required.", 401);
  const conversations = await db.collection("workspaceConversations")
    .find({ participantIds: currentUserId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .toArray();

  const unreadCounts = await getUnreadCountsForUser(db, currentUserId, conversations.map(item => item.conversationId));
  return conversations.map(conversation => serializeMessengerConversation(conversation, currentUserId, usersById, unreadCounts.get(conversation.conversationId) || 0));
}

export async function getConversationForUser({ db, conversationId, currentUserId }) {
  const conversation = await db.collection("workspaceConversations").findOne({ conversationId, participantIds: currentUserId });
  if (!conversation) throw statusError("Conversation not found.", 404);
  return conversation;
}

export async function listMessengerMessages({ db, conversationId, currentUserId, limit, before }) {
  await getConversationForUser({ db, conversationId, currentUserId });
  const cleanLimit = Math.max(1, Math.min(MAX_MESSAGE_LIMIT, Number(limit) || DEFAULT_MESSAGE_LIMIT));
  const filter = { conversationId };
  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.getTime())) filter.createdAt = { $lt: beforeDate };
  }
  const messages = await db.collection("workspaceMessengerMessages")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(cleanLimit)
    .toArray();
  return messages.reverse().map(serializeMessengerMessage);
}

export async function sendMessengerMessage({ db, conversationId, currentUserId, body, clientMessageId, now = new Date() }) {
  const conversation = await getConversationForUser({ db, conversationId, currentUserId });
  const cleanBody = cleanMessengerText(body);
  if (!cleanBody) throw statusError("Message is required.", 400);
  const cleanClientMessageId = cleanMessengerText(clientMessageId, 160);

  if (cleanClientMessageId) {
    const existing = await db.collection("workspaceMessengerMessages").findOne({ conversationId, clientMessageId: cleanClientMessageId });
    if (existing) return { message: serializeMessengerMessage(existing), duplicate: true };
  }

  const messageDoc = {
    conversationId,
    participantIds: conversation.participantIds,
    fromId: currentUserId,
    body: cleanBody,
    attachments: [],
    readBy: [currentUserId],
    clientMessageId: cleanClientMessageId || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection("workspaceMessengerMessages").insertOne(messageDoc);
  await db.collection("workspaceConversations").updateOne(
    { conversationId },
    {
      $set: {
        updatedAt: now,
        lastMessage: { fromId: currentUserId, body: cleanBody, createdAt: now },
      },
    },
  );
  return { message: serializeMessengerMessage({ ...messageDoc, _id: result.insertedId }), duplicate: false };
}

export async function markConversationRead({ db, conversationId, currentUserId, now = new Date() }) {
  await getConversationForUser({ db, conversationId, currentUserId });
  const result = await db.collection("workspaceMessengerMessages").updateMany(
    { conversationId, readBy: { $ne: currentUserId } },
    { $addToSet: { readBy: currentUserId }, $set: { updatedAt: now } },
  );
  return { markedRead: result.modifiedCount || 0 };
}

export async function getMessengerUnreadTotal({ db, currentUserId }) {
  return await db.collection("workspaceMessengerMessages").countDocuments({ participantIds: currentUserId, readBy: { $ne: currentUserId } });
}

async function getUnreadCountsForUser(db, currentUserId, conversationIds) {
  if (!conversationIds.length) return new Map();
  const rows = await db.collection("workspaceMessengerMessages").aggregate([
    { $match: { conversationId: { $in: conversationIds }, participantIds: currentUserId, readBy: { $ne: currentUserId } } },
    { $group: { _id: "$conversationId", count: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map(row => [row._id, row.count]));
}

function initialsFor(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || "")
    .join("") || "BM";
}

function statusError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}
