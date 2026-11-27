import { randomBytes } from "node:crypto";

const MAX_FIELD_LENGTH = 4000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_SUBJECTS = new Set(["General Inquiry", "Support", "Quote Request", "Partnership"]);

export class ValidationError extends Error {
  constructor(fields) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

function cleanString(value, maxLength = MAX_FIELD_LENGTH) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanMessage(value, maxLength = MAX_FIELD_LENGTH) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function optional(value, maxLength) {
  const cleaned = cleanString(value, maxLength);
  return cleaned || undefined;
}

function requireText(fields, output, source, sourceName, targetName = sourceName, options = {}) {
  const value = cleanString(source[sourceName], options.maxLength);
  if (!value || value.length < (options.minLength || 1)) fields[sourceName] = options.message || "This field is required.";
  output[targetName] = value;
}

function requireEmail(fields, output, source) {
  const email = cleanString(source.email, 320).toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) fields.email = "Please enter a valid email address.";
  output.email = email;
}

function createContactReference(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  return `CNT-${stamp}-${suffix}`;
}

export function validateContactSubmission(body, { allowCustomSubject = false } = {}) {
  const fields = {};
  const source = body && typeof body === "object" ? body : {};
  const doc = {};

  requireText(fields, doc, source, "name", "name", { maxLength: 160, message: "Please enter your name." });
  requireEmail(fields, doc, source);
  doc.phone = optional(source.phone, 80);
  doc.company = optional(source.company, 180);
  doc.orderNumber = optional(source.orderNumber, 100);
  doc.subject = optional(source.subject, 220);
  if (doc.subject && !CONTACT_SUBJECTS.has(doc.subject) && !allowCustomSubject) fields.subject = "Please select a valid subject.";
  const message = cleanMessage(source.message, 4000);
  if (!message || message.length < 3) fields.message = "Please enter your message.";
  doc.message = message;

  if (Object.keys(fields).length) throw new ValidationError(fields);
  const createdAt = new Date();
  return { ...doc, reference: createContactReference(createdAt), status: "new", createdAt, updatedAt: new Date(createdAt) };
}

export function validateQuoteSubmission(body) {
  const fields = {};
  const source = body && typeof body === "object" ? body : {};
  const doc = {};

  requireText(fields, doc, source, "name", "name", { maxLength: 160, message: "Please enter your name." });
  requireEmail(fields, doc, source);
  doc.phone = optional(source.phone, 80);
  doc.company = optional(source.company, 180);
  requireText(fields, doc, source, "service", "service", { maxLength: 220, message: "Please select a service." });
  doc.budget = optional(source.budget, 120);
  requireText(fields, doc, source, "projectDescription", "projectDescription", { minLength: 10, maxLength: 5000, message: "Please describe your project." });
  doc.desiredTimeline = optional(source.desiredTimeline, 120);

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { ...doc, status: "new", createdAt: new Date(), updatedAt: new Date() };
}
