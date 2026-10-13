import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createHealthServer } from "../src/server.js";
import { createAdminSession } from "../src/adminAuth.js";
import {
  getOrCreatePrivateConversation,
  listMessengerContacts,
  listMessengerConversations,
  listMessengerMessages,
  markConversationRead,
  sendMessengerMessage,
} from "../src/workspaceMessenger.js";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3010,https://admin-bluemindwebservise.vercel.app",
  NODE_ENV: "development",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_M_PASSWORD_HASH: bcrypt.hashSync("m-password", 10),
  ADMIN_R_PASSWORD_HASH: bcrypt.hashSync("r-password", 10),
  WORKSPACE_AHMED_PASSWORD_HASH: bcrypt.hashSync("ahmed-password", 10),
  WORKSPACE_AMMAR_PASSWORD_HASH: bcrypt.hashSync("ammar-password", 10),
  WORKSPACE_PATRICK_PASSWORD_HASH: bcrypt.hashSync("patrick-password", 10),
  ADMIN_SESSION_SECRET: "test-secret-with-at-least-thirty-two-characters",
};

async function withServer(run) {
  const server = createHealthServer(env);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

class FakeCollection {
  constructor() {
    this.docs = [];
    this.nextId = 1;
  }

  async updateOne(filter, update, options = {}) {
    let doc = this.docs.find(item => matches(item, filter));
    if (!doc && options.upsert) {
      doc = { ...(update.$setOnInsert || {}) };
      this.docs.push(doc);
    }
    if (!doc) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$setOnInsert && !doc._id && options.upsert) Object.assign(doc, update.$setOnInsert);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async findOne(filter) {
    return this.docs.find(item => matches(item, filter)) || null;
  }

  async insertOne(doc) {
    const inserted = { ...doc, _id: `fake-${this.nextId++}` };
    this.docs.push(inserted);
    return { insertedId: inserted._id };
  }

  find(filter = {}) {
    let rows = this.docs.filter(item => matches(item, filter));
    return chain(rows);
  }

  aggregate(pipeline) {
    let rows = [...this.docs];
    for (const stage of pipeline) {
      if (stage.$match) rows = rows.filter(item => matches(item, stage.$match));
      if (stage.$group) {
        const groups = new Map();
        for (const row of rows) groups.set(row.conversationId, (groups.get(row.conversationId) || 0) + 1);
        rows = [...groups.entries()].map(([id, count]) => ({ _id: id, count }));
      }
    }
    return { toArray: async () => rows };
  }

  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (!matches(doc, filter)) continue;
      if (update.$addToSet) {
        for (const [key, value] of Object.entries(update.$addToSet)) {
          doc[key] = Array.isArray(doc[key]) ? doc[key] : [];
          if (!doc[key].includes(value)) doc[key].push(value);
        }
      }
      if (update.$set) Object.assign(doc, update.$set);
      modifiedCount++;
    }
    return { modifiedCount };
  }

  async countDocuments(filter) {
    return this.docs.filter(item => matches(item, filter)).length;
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
    return this.collections.get(name);
  }
}

function chain(rows) {
  return {
    sort(sortSpec = {}) {
      const [[key, direction] = []] = Object.entries(sortSpec);
      if (key) {
        rows = [...rows].sort((a, b) => {
          const av = a[key] instanceof Date ? a[key].getTime() : a[key];
          const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
          if (av === bv) return 0;
          return av > bv ? direction : -direction;
        });
      }
      return this;
    },
    limit(count) {
      rows = rows.slice(0, count);
      return this;
    },
    toArray: async () => rows,
  };
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ("$ne" in expected) return Array.isArray(actual) ? !actual.includes(expected.$ne) : actual !== expected.$ne;
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$lt" in expected) return actual < expected.$lt;
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

test("Messenger contacts list existing Workspace users without exposing the current user", async () => {
  const contacts = await listMessengerContacts({ env, currentUserId: "AHMED" });
  assert.deepEqual(contacts.map(contact => contact.employeeId).sort(), ["AMMAR", "M", "PATRICK", "R"]);
  assert.equal(contacts.find(contact => contact.employeeId === "M").displayName, "Mohmed");
  assert.equal(contacts.find(contact => contact.employeeId === "PATRICK").title, "Android Developer");
});

test("Messenger contacts endpoint works for admin and employee sessions", async () => {
  await withServer(async base => {
    const ahmedCookie = `bluemind_admin_session=${encodeURIComponent(createAdminSession(env, { access: "employee", email: "ahmed@bluemind.com", employeeId: "AHMED", displayName: "Ahmed", title: "iOS Developer" }))}`;
    const adminCookie = `bluemind_admin_session=${encodeURIComponent(createAdminSession(env, "M"))}`;

    const employeeContacts = await fetch(`${base}/api/workspace/messenger/contacts`, { headers: { Cookie: ahmedCookie } });
    assert.equal(employeeContacts.status, 200);
    const employeeJson = await employeeContacts.json();
    assert.equal(employeeJson.contacts.length, 4);
    assert.equal(employeeJson.contacts.some(contact => contact.employeeId === "AHMED"), false);

    const adminContacts = await fetch(`${base}/api/workspace/messenger/contacts`, { headers: { Cookie: adminCookie } });
    assert.equal(adminContacts.status, 200);
    const adminJson = await adminContacts.json();
    assert.equal(adminJson.contacts.length, 4);
    assert.equal(adminJson.contacts.some(contact => contact.employeeId === "M"), false);
  });
});

test("Messenger Stage 1 persists private text messages and enforces participants", async () => {
  const db = new FakeDb();
  const conversation = await getOrCreatePrivateConversation({ db, env, currentUserId: "AHMED", contactId: "AMMAR", now: new Date("2026-10-13T10:00:00Z") });
  assert.equal(conversation.conversationId, "AHMED--AMMAR");
  assert.deepEqual(conversation.participantIds, ["AHMED", "AMMAR"]);

  const sent = await sendMessengerMessage({ db, conversationId: conversation.conversationId, currentUserId: "AHMED", body: "  Hello Ammar  ", clientMessageId: "client-1", now: new Date("2026-10-13T10:01:00Z") });
  assert.equal(sent.duplicate, false);
  assert.equal(sent.message.body, "Hello Ammar");
  assert.deepEqual(sent.message.readBy, ["AHMED"]);

  const duplicate = await sendMessengerMessage({ db, conversationId: conversation.conversationId, currentUserId: "AHMED", body: "Hello again", clientMessageId: "client-1", now: new Date("2026-10-13T10:02:00Z") });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.body, "Hello Ammar");

  const conversationsForAmmar = await listMessengerConversations({ db, env, currentUserId: "AMMAR" });
  assert.equal(conversationsForAmmar.length, 1);
  assert.equal(conversationsForAmmar[0].contact.employeeId, "AHMED");
  assert.equal(conversationsForAmmar[0].unreadCount, 1);

  const messagesForAmmar = await listMessengerMessages({ db, conversationId: conversation.conversationId, currentUserId: "AMMAR" });
  assert.equal(messagesForAmmar.length, 1);
  assert.equal(messagesForAmmar[0].fromId, "AHMED");

  const read = await markConversationRead({ db, conversationId: conversation.conversationId, currentUserId: "AMMAR" });
  assert.equal(read.markedRead, 1);
  const afterRead = await listMessengerConversations({ db, env, currentUserId: "AMMAR" });
  assert.equal(afterRead[0].unreadCount, 0);

  await assert.rejects(
    () => listMessengerMessages({ db, conversationId: conversation.conversationId, currentUserId: "PATRICK" }),
    /Conversation not found/,
  );
});