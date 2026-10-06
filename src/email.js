import nodemailer from "nodemailer";

const BUSINESS_EMAIL = "admin@xn--bluemndwebservice-gvc.com";
const EMAIL_TIMEOUT_MS = 8000;

let transporter;

function getEmailConfig(env) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.EMAIL_FROM || user || BUSINESS_EMAIL;
  const to = env.EMAIL_TO || BUSINESS_EMAIL;

  if (!host || !user || !pass) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP_PORT");

  return { host, port, user, pass, from, to };
}

function getTransporter(config) {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      connectionTimeout: EMAIL_TIMEOUT_MS,
      greetingTimeout: EMAIL_TIMEOUT_MS,
      socketTimeout: EMAIL_TIMEOUT_MS,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }
  return transporter;
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
    console.warn("Email notification skipped: SMTP is not configured");
    return { sent: false, reason: "not_configured" };
  }

  const result = await Promise.race([
    getTransporter(config).sendMail(buildFormMailOptions(config, route, doc)),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("SMTP notification timed out")), EMAIL_TIMEOUT_MS).unref();
    }),
  ]);
  console.log("Email notification sent", { route, messageId: result.messageId ? "present" : "missing" });

  return { sent: true };
}
