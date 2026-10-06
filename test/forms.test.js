import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/server.js";
import { buildContactEmail, buildFormMailOptions, buildQuoteEmail } from "../src/email.js";
import { validateContactSubmission, validateQuoteSubmission, ValidationError } from "../src/validation.js";

const env = { ALLOWED_ORIGINS: "http://localhost:3000,https://bluemindwebservice.com", NODE_ENV: "production" };

async function withServer(run) {
  const server = createHealthServer(env);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("contact and quote routes reject invalid submissions before storage", async () => {
  await withServer(async base => {
    const contact = await fetch(`${base}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://bluemindwebservice.com" },
      body: JSON.stringify({ name: "", email: "not-email", message: "" })
    });
    assert.equal(contact.status, 400);
    assert.equal(contact.headers.get("access-control-allow-origin"), "https://bluemindwebservice.com");
    const contactBody = await contact.json();
    assert.equal(contactBody.success, false);
    assert.equal(contactBody.fields.email, "Please enter a valid email address.");

    const quote = await fetch(`${base}/api/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com", service: "", projectDescription: "short" })
    });
    assert.equal(quote.status, 400);
    const quoteBody = await quote.json();
    assert.equal(quoteBody.success, false);
    assert.equal(quoteBody.fields.service, "Please select a service.");
  });
});

test("form routes protect methods, content type, and preflight", async () => {
  await withServer(async base => {
    const preflight = await fetch(`${base}/api/contact`, { method: "OPTIONS", headers: { Origin: "https://bluemindwebservice.com", "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");

    assert.equal((await fetch(`${base}/api/contact`)).status, 405);
    assert.equal((await fetch(`${base}/api/quote`, { method: "POST", body: "name=Ada" })).status, 415);
  });
});

test("validators trim and shape stored documents", () => {
  const contact = validateContactSubmission({ name: " Ada ", email: " ADA@Example.COM ", message: " Hello ", company: " BlueMind " });
  assert.equal(contact.name, "Ada");
  assert.equal(contact.email, "ada@example.com");
  assert.equal(contact.company, "BlueMind");
  assert.equal(contact.status, "new");
  assert.ok(contact.createdAt instanceof Date);

  const quote = validateQuoteSubmission({ name: "Ada", email: "ada@example.com", service: "Business Website", projectDescription: "A complete company website.", desiredTimeline: "Soon" });
  assert.equal(quote.status, "new");
  assert.equal(quote.service, "Business Website");

  assert.throws(() => validateContactSubmission({}), ValidationError);
  assert.throws(() => validateQuoteSubmission({}), ValidationError);
});

test("email notifications include inquiry details", () => {
  const contact = validateContactSubmission({
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 555 0100",
    company: "Analytical Engines",
    subject: "Website help",
    message: "Please contact me about a website.",
  });
  const contactEmail = buildContactEmail(contact);
  assert.equal(contactEmail.subject, "New BlueMind Website Inquiry - Ada Lovelace");
  assert.match(contactEmail.text, /Name: Ada Lovelace/);
  assert.match(contactEmail.text, /Email: ada@example.com/);
  assert.match(contactEmail.text, /Source: BlueMind Web Service Contact Form/);

  const quote = validateQuoteSubmission({
    name: "Grace Hopper",
    email: "grace@example.com",
    service: "Business Website",
    budget: "$2,000 - $5,000",
    projectDescription: "Build a polished website for a service business.",
    desiredTimeline: "This month",
  });
  const quoteEmail = buildQuoteEmail(quote);
  assert.equal(quoteEmail.subject, "New BlueMind Quote Request - Grace Hopper");
  assert.match(quoteEmail.text, /Requested service: Business Website/);
  assert.match(quoteEmail.text, /Budget: \$2,000 - \$5,000/);
  assert.match(quoteEmail.text, /Source: BlueMind Web Service Quote Form/);

  const options = buildFormMailOptions({
    from: "admin@xn--bluemndwebservice-gvc.com",
    to: "admin@xn--bluemndwebservice-gvc.com",
  }, "/api/contact", contact);
  assert.equal(options.from, "admin@xn--bluemndwebservice-gvc.com");
  assert.equal(options.to, "admin@xn--bluemndwebservice-gvc.com");
  assert.equal(options.replyTo, "ada@example.com");
});
