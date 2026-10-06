import { ValidationError } from "./validation.js";

export const ORDER_STATUSES = [
  "New",
  "In Progress",
  "Waiting for Client",
  "Ready",
  "Completed",
  "Cancelled",
];

const PAYMENT_STATUSES = ["Paid", "Unpaid"];

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function optional(value, maxLength) {
  return cleanString(value, maxLength) || undefined;
}

function requireText(fields, doc, source, sourceName, targetName = sourceName, maxLength = 240) {
  const value = cleanString(source[sourceName], maxLength);
  if (!value) fields[sourceName] = "This field is required.";
  doc[targetName] = value;
}

function parseDate(fields, doc, source, sourceName) {
  const raw = cleanString(source[sourceName], 80);
  const value = raw ? new Date(raw) : null;
  if (!value || Number.isNaN(value.getTime())) fields[sourceName] = "Please enter a valid date.";
  doc[sourceName] = value;
}

export function normalizeOrderNumber(value) {
  const cleaned = cleanString(value, 40).toUpperCase();
  if (!cleaned) return "";
  const number = cleaned.replace(/^#/, "");
  return `#${number}`;
}

export function validateOrderStatus(value) {
  const status = cleanString(value, 80);
  if (!ORDER_STATUSES.includes(status)) throw new ValidationError({ projectStatus: "Invalid order status." });
  return status;
}

export function validateOrderDocument(body) {
  const fields = {};
  const source = body && typeof body === "object" ? body : {};
  const doc = {};

  doc.orderNumber = normalizeOrderNumber(source.orderNumber);
  if (!/^#\d+$/.test(doc.orderNumber)) fields.orderNumber = "Order number must look like #515.";

  requireText(fields, doc, source, "customerName", "customerName", 160);
  requireText(fields, doc, source, "companyName", "companyName", 180);
  requireText(fields, doc, source, "email", "email", 320);
  requireText(fields, doc, source, "projectType", "projectType", 220);
  requireText(fields, doc, source, "service", "service", 220);
  requireText(fields, doc, source, "package", "package", 220);
  requireText(fields, doc, source, "price", "price", 80);
  parseDate(fields, doc, source, "orderDate");
  parseDate(fields, doc, source, "deliveryDate");
  requireText(fields, doc, source, "projectDescription", "projectDescription", 5000);

  doc.phone = optional(source.phone, 80);
  doc.internalNotes = optional(source.internalNotes, 4000) || "";
  doc.paymentStatus = cleanString(source.paymentStatus, 80) || "Unpaid";
  doc.projectStatus = cleanString(source.projectStatus, 80) || "New";

  if (!PAYMENT_STATUSES.includes(doc.paymentStatus)) fields.paymentStatus = "Invalid payment status.";
  if (!ORDER_STATUSES.includes(doc.projectStatus)) fields.projectStatus = "Invalid order status.";

  if (Object.keys(fields).length) throw new ValidationError(fields);
  const now = new Date();
  return { ...doc, createdAt: now, updatedAt: now };
}

export async function ensureOrderIndexes(db) {
  await db.collection("orders").createIndex({ orderNumber: 1 }, { unique: true });
  await db.collection("orders").createIndex({
    orderNumber: "text",
    customerName: "text",
    companyName: "text",
    email: "text",
  });
}

export function buildOrderSearchQuery(search) {
  const query = cleanString(search, 160);
  if (!query) return {};
  const normalized = normalizeOrderNumber(query);
  const pattern = query.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    $or: [
      { orderNumber: normalized },
      { orderNumber: { $regex: pattern, $options: "i" } },
      { customerName: { $regex: pattern, $options: "i" } },
      { companyName: { $regex: pattern, $options: "i" } },
      { email: { $regex: pattern, $options: "i" } },
    ],
  };
}

export function serializeOrder(order) {
  if (!order) return null;
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    companyName: order.companyName,
    email: order.email,
    phone: order.phone,
    projectType: order.projectType,
    service: order.service,
    package: order.package,
    price: order.price,
    paymentStatus: order.paymentStatus,
    projectStatus: order.projectStatus,
    orderDate: order.orderDate instanceof Date ? order.orderDate.toISOString() : order.orderDate,
    deliveryDate: order.deliveryDate instanceof Date ? order.deliveryDate.toISOString() : order.deliveryDate,
    projectDescription: order.projectDescription,
    internalNotes: order.internalNotes || "",
    createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
    updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt,
  };
}

export function createTestOrder() {
  return validateOrderDocument({
    orderNumber: "#515",
    customerName: "Ahmed Example",
    companyName: "Example Company",
    email: "demo.customer@example.com",
    phone: "+46 70 000 00 15",
    projectType: "E-commerce Website",
    service: "Online Store",
    package: "Business / Store package",
    price: "$1,850",
    paymentStatus: "Paid",
    projectStatus: "New",
    orderDate: "2026-10-06T00:00:00.000Z",
    deliveryDate: "2026-10-25T00:00:00.000Z",
    projectDescription: "Safe demo order for testing the BlueMind internal admin dashboard.",
    internalNotes: "Demo data only. Do not treat as a real customer order.",
  });
}
