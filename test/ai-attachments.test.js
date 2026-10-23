import test from "node:test";
import assert from "node:assert/strict";
import { validateTurns } from "../src/ai/contract.js";
import { prepareAttachments, FILE_LIMITS } from "../src/ai/attachments.js";
import { createAttachmentSessions } from "../src/ai/attachment-session.js";
import { createChatHandler } from "../src/ai/server.js";
import { openAIProvider } from "../src/ai/provider.js";
import { file, image, pdf, docx, xlsx } from "./fixtures/attachments.mjs";

const turn = files => [{ role: "user", content: "Analyze these files", attachments: files }];
const parse = (files, signal = new AbortController().signal, options) => prepareAttachments(turn(files), signal, options);

test("attachment contracts enforce count, bytes, MIME, extension, names, roles and canonical base64", async () => {
  const valid = file("brief.txt", "Hello");
  assert.ok(validateTurns({ messages: [{ role: "user", content: "", attachments: [valid] }] }));
  for (const invalid of [
    { ...valid, name: "../brief.txt" }, { ...valid, type: "image/png" }, { ...valid, name: "run.exe" },
    { ...valid, data: "file:///etc/passwd" }, { ...valid, data: "aGVsbG8" }, { ...valid, extra: true },
    { ...valid, data: Buffer.alloc(FILE_LIMITS.fileBytes + 1).toString("base64") },
  ]) assert.equal(validateTurns({ messages: turn([invalid]) }), null);
  assert.equal(validateTurns({ messages: turn(Array(5).fill(valid)) }), null);
  assert.equal(validateTurns({ messages: turn(Array(2).fill(file("large.txt", Buffer.alloc(1500000, 65)))) }), null);
  assert.equal(validateTurns({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "x", attachments: [valid] }, { role: "user", content: "y" }] }), null);
});

for (const format of ["jpeg", "png", "webp"]) test(`decodes and sanitizes real ${format} image pixels`, async () => {
  const result = await parse([await image(format)]);
  assert.match(result[0].content[2].image_url, /^data:image\/webp;base64,/);
});

test("multiple images and follow-up context retain actual inputs in their original turn", async () => {
  const messages = [...turn([await image(), await image("webp", 480, 320)]), { role: "assistant", content: "A comparison" }, { role: "user", content: "What about the colors?" }];
  const result = await prepareAttachments(messages, new AbortController().signal);
  assert.equal(result[0].content.filter(part => part.type === "input_image").length, 2);
  assert.deepEqual(result.slice(1), messages.slice(1));
});

test("PDF input includes actual bounded pages", async () => {
  const input = await pdf(); const result = await parse([input]);
  assert.equal(result[0].content[1].type, "input_file");
  assert.equal(result[0].content[1].file_data, `data:application/pdf;base64,${input.data}`);
  await assert.rejects(parse([await pdf(11)]), { code: "attachment_limit" });
  await assert.rejects(parse([await pdf(6), await pdf(6)]), { code: "attachment_limit" });
});
test("DOCX extracts readable paragraphs and explicitly scopes nontext exclusions", async () => {
  const result = await parse([await docx()]); const value = JSON.parse(result[0].content[1].text);
  assert.match(value.content, /Cedar Cafe/); assert.match(value.content, /\n\nInclude a menu/);
  assert.match(value.analysis_scope, /NOT included/);
});
test("XLSX extracts sheet names and cell values without executing formulas", async () => {
  const result = await parse([await xlsx()]); const value = JSON.parse(result[0].content[1].text);
  assert.match(value.content, /Budget/); assert.match(value.content, /Landing pages/); assert.match(value.content, /7/);
  assert.match(value.analysis_scope, /NOT recalculated/);
});
test("TXT preserves multilingual UTF-8 and rejects invalid text or truncation", async () => {
  const result = await parse([file("brief.txt", "Hej! \u0645\u0631\u062d\u0628\u0627\nWebsite plan.")]);
  assert.match(result[0].content[1].text, /Hej!/);
  await assert.rejects(parse([file("bad.txt", Buffer.from([0xff, 0x00]))]), { code: "attachment_invalid" });
  await assert.rejects(parse([file("long.txt", "x".repeat(40001))]), { code: "attachment_limit" });
});
test("signature mismatch, scripts, encrypted containers and hostile ZIP packages are rejected", async () => {
  for (const input of [file("wrong.png", "not pixels"), file("renamed.png", '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'), file("wrong.pdf", "not a PDF"), file("wrong.docx", "not a ZIP"),
    await docx({ "word/vbaProject.bin": "macro" }), await docx({ "../escape.xml": "<x/>" }),
    await docx({ "word/hostile.xml": '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>' }),
    await docx({ "word/bomb.xml": "x".repeat(5 * 1024 * 1024) }),
  ]) await assert.rejects(parse([input]), { code: "attachment_invalid" });
});
test("worker timeout and cancellation terminate parsing and allow later requests", async () => {
  await assert.rejects(parse([await docx()], undefined, { timeoutMs: 1 }), { code: "attachment_limit" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parse([file("a.txt", "hello")], controller.signal));
  assert.ok(await parse([file("a.txt", "hello")]));
});
test("upload session capability expires, rejects tampering and has bounded issuance", () => {
  let now = Date.now(); const sessions = createAttachmentSessions(() => now);
  const token = sessions.issue(); assert.equal(sessions.verify(token), true);
  assert.equal(sessions.verify(token + "x"), false); assert.equal(sessions.verify("anything"), false);
  now += 20 * 60000; assert.equal(sessions.verify(token), false);
  for (let i = 0; i < 60; i++) assert.ok(sessions.issue());
  assert.equal(sessions.issue(), null);
});

test("attachment analyses have separate minute and daily spending caps", () => {
  let now = Date.now(); const sessions = createAttachmentSessions(() => now);
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 0; i < 4; i++) assert.equal(sessions.allowAnalysis(), true);
    assert.equal(sessions.allowAnalysis(), false); now += 60000;
  }
  assert.equal(sessions.allowAnalysis(), false);
  now += 86400000; assert.equal(sessions.allowAnalysis(), true);
});
test("handler requires upload authorization, passes parsed data to provider and never logs contents", async () => {
  const env = { AI_ENABLED: "true", OPENAI_API_KEY: "test-only", AI_ALLOWED_ORIGINS: "https://website.test" };
  const logs = []; let inputs;
  const handle = createChatHandler({ env, log: entry => logs.push(entry), provider: async messages => {
    inputs = messages; return (async function* () { yield { type: "delta", text: "Analysis fixture" }; yield { type: "done" }; })();
  } });
  const req = (path, body, token) => new Request(`https://website.test/api/ai/${path}`, { method: "POST", headers: { Origin: "https://website.test", "Content-Type": "application/json", ...(token ? { "x-ai-attachment-session": token } : {}) }, body: JSON.stringify(body) });
  const body = { messages: turn([file("private.txt", "PRIVATE-CONTENT-765")]) };
  assert.equal((await handle(req("chat", body))).status, 401);
  const auth = await (await handle(req("attachment-session", {}))).json();
  const response = await handle(req("chat", body, auth.token));
  assert.equal(response.status, 200); assert.match(await response.text(), /done/);
  assert.match(inputs[0].content[1].text, /PRIVATE-CONTENT-765/);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-CONTENT|private.txt|test-only/);
});

test("official SDK sends actual image, PDF and document text through Responses without storage", async () => {
  const prepared = await parse([await image(), await pdf(), await docx(), await xlsx()]);
  let request;
  const provider = openAIProvider("unit-test-not-a-key", "gpt-5.4-mini", async (url, init) => {
    assert.match(String(url), /\/v1\/responses$/);
    request = JSON.parse(init.body);
    return new Response('data: {"type":"response.output_text.delta","delta":"Fixture"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const events = [];
  for await (const event of await provider(prepared, new AbortController().signal)) events.push(event);
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.deepEqual(request.input, prepared);
  assert.ok(request.input[0].content.some(part => part.type === "input_image"));
  assert.ok(request.input[0].content.some(part => part.type === "input_file"));
  assert.match(request.instructions, /untrusted DATA/);
  assert.equal(events.at(-1).type, "done");
});
