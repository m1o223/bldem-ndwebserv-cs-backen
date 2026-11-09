import test from "node:test";
import assert from "node:assert/strict";
import { createAiConversationStore } from "../src/ai/conversations.js";
import { createChatHandler } from "../src/ai/server.js";
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

test("persistence IDs stay server-side and are not sent to the model", async () => {
  let providerInput;
  const handler = createChatHandler({
    env: { AI_ENABLED: "true", OPENAI_API_KEY: "test-key", AI_ALLOWED_ORIGINS: "https://bluemindwebservice.com" },
    provider: async messages => {
      providerInput = messages;
      return (async function* () {
        yield { type: "delta", text: "Connected." };
        yield { type: "done", inputTokens: 1, outputTokens: 1 };
      })();
    },
    conversations: {
      authorize: async () => ({}),
      saveCompleted: async () => {},
    },
  });
  const response = await handler(new Request("http://backend.internal/api/ai/chat", {
    method: "POST",
    headers: { Origin: "https://bluemindwebservice.com", "Content-Type": "application/json", "x-ai-conversation-id": conversationId },
    body: JSON.stringify({ messages: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "user", content: "Hello" }] }),
  }));
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(providerInput[0].id, undefined);
  assert.equal(providerInput[0].content, "Hello");
});
