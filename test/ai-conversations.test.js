import test from "node:test";
import assert from "node:assert/strict";
import { createAiConversationStore } from "../src/ai/conversations.js";
import { memoryDatabase } from "./fixtures/customer-memory.mjs";

const visitorToken = "a".repeat(64);
const customerToken = "b".repeat(64);
const otherCustomerToken = "c".repeat(64);
const conversationId = "11111111-1111-4111-8111-111111111111";

test("visitor conversation is claimed by the same customer and remains private", async () => {
  const db = memoryDatabase();
  const customerAuth = { session: async token => token === customerToken ? { id: "customer-1" } : token === otherCustomerToken ? { id: "customer-2" } : null };
  const store = createAiConversationStore({ database: async () => db, customerAuth });

  await store.saveCompleted({
    conversationId, visitorToken,
    messages: [{ id: "user-1", role: "user", content: "I need a cafe website." }],
    assistantText: "Let's organize the cafe requirements.",
  });
  const visitorView = await store.getForUser({ conversationId, visitorToken });
  assert.equal(visitorView.messages.length, 2);
  assert.equal(visitorView.messages[0].role, "user");
  assert.equal(visitorView.messages[0].content, "I need a cafe website.");

  await store.saveCompleted({
    conversationId, authorization: `Bearer ${customerToken}`, visitorToken,
    messages: [
      { id: "user-1", role: "user", content: "I need a cafe website." },
      { id: "user-1:assistant", role: "assistant", content: "Let's organize the cafe requirements." },
      { id: "user-2", role: "user", content: "Add a menu page." },
    ],
    assistantText: "A menu page will fit the cafe project.",
  });
  const accountView = await store.getForUser({ conversationId, authorization: `Bearer ${customerToken}` });
  assert.equal(accountView.messages.length, 4);
  assert.equal((await store.listForCustomer({ authorization: `Bearer ${customerToken}` })).length, 1);
  await assert.rejects(() => store.getForUser({ conversationId, authorization: `Bearer ${otherCustomerToken}` }), error => error.statusCode === 404);
  await assert.rejects(() => store.getForUser({ conversationId, visitorToken: "d".repeat(64) }), error => error.statusCode === 404);
});
