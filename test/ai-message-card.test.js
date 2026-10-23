import assert from "node:assert/strict";
import test from "node:test";
import { openAIProvider, instructions } from "../src/ai/provider.js";
import { createChatHandler } from "../src/ai/server.js";
import { validateTurns } from "../src/ai/contract.js";
import { MESSAGE_CARD_FORMAT, messageCardTool, validateMessageCard } from "../src/ai/message-card.js";

const card = { title: "Website inquiry", body: "Hello,\n\nPlease share the next steps.\n\nThank you." };
const messages = [{ role: "user", content: "Draft a website inquiry" }];
const item = value => ({ type: "response.output_item.done", item: { type: "function_call", name: "display_message_card", arguments: JSON.stringify(value) } });
const done = { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 30 } } };
const sdk = (events, inspect = () => {}) => openAIProvider("test-key-not-real", "gpt-5.4-mini", async (_, init) => {
  inspect(JSON.parse(init.body));
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
});
const collect = async (provider, enabled = true) => Array.fromAsync(await provider(messages, new AbortController().signal, { messageCards: enabled }));
const request = (enabled = true) => new Request("https://website.test/api/ai/chat", {
  method: "POST", headers: { Origin: "https://website.test", "Content-Type": "application/json" },
  body: JSON.stringify({ messages, ...(enabled ? { responseFormat: MESSAGE_CARD_FORMAT } : {}) }),
});
const run = async (provider, enabled = true) => {
  const logs = [];
  const handler = createChatHandler({ provider, env: { AI_ENABLED: "true", OPENAI_API_KEY: "test-key", AI_ALLOWED_ORIGINS: "https://website.test" }, log: value => logs.push(value) });
  const response = await handler(request(enabled));
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  return { events, logs };
};

test("card capability is explicit and validation rejects unknown formats and unsafe shapes", () => {
  assert.deepEqual(validateTurns({ messages, responseFormat: MESSAGE_CARD_FORMAT }), messages);
  for (const responseFormat of [null, {}, "json", "admin"]) assert.equal(validateTurns({ messages, responseFormat }), null);
  for (const value of [null, [], {}, { ...card, sendTo: "someone" }, { ...card, title: " " }, { ...card, body: 4 }, { ...card, title: "a".repeat(201) }, { ...card, body: "a".repeat(11001) }]) assert.equal(validateMessageCard(value), null);
  assert.deepEqual(validateMessageCard(card), card);
});

test("strict card tool is opt-in and leaves existing plain-text API settings unchanged", async () => {
  let sent;
  const output = await collect(sdk([item(card), done], value => { sent = value; }));
  assert.deepEqual(sent.tools, [messageCardTool]);
  assert.equal(sent.parallel_tool_calls, false);
  assert.equal(sent.tools[0].strict, true);
  assert.equal(sent.tools[0].parameters.additionalProperties, false);
  assert.ok(sent.instructions.startsWith(instructions));
  assert.match(sent.instructions, /Never invent names/);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(sent.max_output_tokens, 2000);
  assert.deepEqual(output, [{ type: "message_card", card }, { type: "done", inputTokens: 20, outputTokens: 30 }]);
  await collect(sdk([{ type: "response.output_text.delta", delta: "Hello" }, done], value => { sent = value; }), false);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.instructions, instructions);
});

test("partial function arguments never leak and completed cards preserve usage metrics", async () => {
  const result = await run(sdk([{ type: "response.function_call_arguments.delta", delta: '{"title":' }, item(card), done]));
  assert.deepEqual(result.events, [{ type: "message_card", card }, { type: "done" }]);
  assert.equal(result.logs[0].inputTokens, 20);
  assert.equal(result.logs[0].outputTokens, 30);
  assert.doesNotMatch(JSON.stringify(result.logs), /Website inquiry|test-key|Please share/);
});

test("incomplete, malformed, oversized and duplicate tools fail safely without publishing a card", async () => {
  for (const events of [
    [item(card), { type: "response.incomplete", response: {} }],
    [item({ ...card, body: "x".repeat(11001) }), done],
    [item(card), item(card), done],
    [{ type: "response.output_item.done", item: { type: "function_call", name: "display_message_card", arguments: "private malformed JSON" } }, done],
    [{ type: "response.output_item.done", item: { type: "function_call", name: "send_payment", arguments: "{}" } }, done],
  ]) {
    const { events: output, logs } = await run(sdk(events));
    assert.deepEqual(output, [{ type: "error", code: "failed" }]);
    assert.doesNotMatch(JSON.stringify(logs), /private malformed/);
  }
});

test("server independently rejects non-opted-in, duplicate and over-limit card events", async () => {
  const provider = events => async () => (async function* () { yield* events; })();
  const event = { type: "message_card", card };
  const { events: legacy } = await run(provider([event, { type: "done" }]), false);
  assert.deepEqual(legacy, [{ type: "error", code: "failed" }]);
  for (const events of [[event, event], [{ type: "delta", text: "x".repeat(11990) }, event], [{ type: "message_card", card: {} }]]) {
    const result = await run(provider([...events, { type: "done" }]));
    assert.equal(result.events.at(-1).type, "error");
    assert.ok(!result.events.some(event => event.type === "done"));
  }
});

test("normal streaming and model refusals still work when cards are enabled", async () => {
  for (const type of ["response.output_text.delta", "response.refusal.delta"]) {
    const { events } = await run(sdk([{ type, delta: "An ordinary answer" }, done]));
    assert.deepEqual(events, [{ type: "delta", text: "An ordinary answer" }, { type: "done" }]);
  }
});
