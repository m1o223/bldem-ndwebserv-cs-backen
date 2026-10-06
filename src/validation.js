const MAX_FIELD_LENGTH = 4000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function validateContactSubmission(body) {
  const fields = {};
  const source = body && typeof body === "object" ? body : {};
  const doc = {};

  requireText(fields, doc, source, "name", "name", { maxLength: 160, message: "Please enter your name." });
  requireEmail(fields, doc, source);
  doc.phone = optional(source.phone, 80);
  doc.company = optional(source.company, 180);
  doc.subject = optional(source.subject, 220);
  requireText(fields, doc, source, "message", "message", { minLength: 3, maxLength: 4000, message: "Please enter your message." });

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { ...doc, status: "new", createdAt: new Date(), updatedAt: new Date() };
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
