import { Resend } from "resend";

const BUSINESS_EMAIL = "admin@xn--bluemndwebservice-gvc.com";
const DEFAULT_SENDER = "BlueMind Web Service <notifications@xn--bluemndwebservice-gvc.com>";

let resendClient;
let activeApiKey;

function getEmailConfig(env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM || DEFAULT_SENDER;
  const to = env.EMAIL_TO || BUSINESS_EMAIL;

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) return null;

  return { apiKey: apiKey.trim(), from, to };
}

function getResendClient(apiKey) {
  if (!resendClient || activeApiKey !== apiKey) {
    resendClient = new Resend(apiKey);
    activeApiKey = apiKey;
  }
  return resendClient;
}

function line(label, value) {
  return `${label}: ${value || "Not provided"}`;
}

function formatDate(value) {
  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}

export function buildContactEmail(contact) {
  return {
    subject: `New BlueMind Website Inquiry - ${contact.name}`,
    text: [
      line("Name", contact.name),
      line("Email", contact.email),
      line("Phone", contact.phone),
      line("Company", contact.company),
      line("Subject", contact.subject),
      line("Message", contact.message),
      line("Date", formatDate(contact.createdAt)),
      "Source: BlueMind Web Service Contact Form",
    ].join("\n"),
  };
}

export function buildQuoteEmail(quote) {
  return {
    subject: `New BlueMind Quote Request - ${quote.name}`,
    text: [
      line("Name", quote.name),
      line("Email", quote.email),
      line("Phone", quote.phone),
      line("Company", quote.company),
      line("Requested service", quote.service),
      line("Budget", quote.budget),
      line("Project description", quote.projectDescription),
      line("Desired timeline", quote.desiredTimeline),
      line("Submission date", formatDate(quote.createdAt)),
      "Source: BlueMind Web Service Quote Form",
    ].join("\n"),
  };
}

export function buildFormMailOptions(config, route, doc) {
  const email = route === "/api/contact" ? buildContactEmail(doc) : buildQuoteEmail(doc);
  return {
    from: config.from,
    to: config.to,
    replyTo: doc.email,
    subject: email.subject,
    text: email.text,
  };
}

export async function sendFormNotification(env, route, doc) {
  const config = getEmailConfig(env);
  if (!config) {
    console.warn("Email notification skipped: Resend is not configured");
    return { sent: false, reason: "not_configured" };
  }

  const result = await getResendClient(config.apiKey).emails.send(buildFormMailOptions(config, route, doc));
  if (result.error) throw new Error(result.error.message || "Resend email send failed");
  console.log("Email notification sent", { route, provider: "resend", id: result.data?.id ? "present" : "missing" });

  return { sent: true };
}
