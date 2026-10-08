import { ValidationError } from "./validation.js";
import {
  calculatePaymentAmounts,
  createPriceSnapshot,
  formatSek,
  normalizePaymentOption,
  validateFixedPricePackage,
} from "./pricing.js";

export const ORDER_STATUSES = [
  "Pending Review",
  "Awaiting Clarification",
  "Confirmed",
  "In Progress",
  "Design Preview",
  "Revisions",
  "Final Review",
  "Awaiting Final Payment",
  "Completed",
  "New",
  "Waiting for Client",
  "Ready",
  "Cancelled",
];

export const PAYMENT_STATUSES = [
  "Pending",
  "Paid",
  "Deposit Paid",
  "Partially Paid",
  "Final Balance Due",
  "Refunded",
  "Unpaid",
];

export const ORDER_EVENT_TYPES = [
  "order_created",
  "new_paid_order",
  "deposit_received",
  "final_payment_received",
  "project_details_submitted",
  "order_confirmed",
  "order_viewed",
  "clarification_requested",
  "notification_queued",
  "notification_sent",
  "notification_failed",
  "order_ready",
  "care_subscription_prepared",
];

export const ORDER_REVIEW_STATUSES = [
  "pending_review",
  "confirmed",
];

export const CARE_PLAN_IDS = ["care-basic", "care-plus", "care-pro"];
export const CARE_BILLING_INTERVALS = ["monthly", "yearly"];

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

export function validatePaymentStatus(value) {
  const status = cleanString(value, 80);
  if (!PAYMENT_STATUSES.includes(status)) throw new ValidationError({ paymentStatus: "Invalid payment status." });
  return status;
}

function cleanStringArray(value, maxItems = 24, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanObjectStrings(value, allowedKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const key of allowedKeys) {
    const cleaned = optional(value[key], 1000);
    if (cleaned) result[key] = cleaned;
  }
  return result;
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
  await db.collection("orders").createIndex({ packageId: 1 });
  await db.collection("orders").createIndex({ paymentStatus: 1 });
  await db.collection("orders").createIndex({ projectStatus: 1 });
  await db.collection("orders").createIndex({ reviewStatus: 1 });
  await db.collection("orders").createIndex({ createdAt: -1 });
  await db.collection("orders").createIndex({
    orderNumber: "text",
    customerName: "text",
    companyName: "text",
    email: "text",
  });
  await db.collection("paymentEvents").createIndex({ provider: 1, eventId: 1 }, { unique: true });
  await db.collection("orderNotifications").createIndex({ orderNumber: 1, type: 1, dedupeKey: 1 }, { unique: true });
  await db.collection("orderNotifications").createIndex({ status: 1, updatedAt: -1 });
  await db.collection("careSubscriptions").createIndex({ orderNumber: 1 });
  await db.collection("careSubscriptions").createIndex({ customerEmail: 1 });
  await db.collection("orderEmailVerifications").createIndex({ email: 1, createdAt: -1 });
  await db.collection("orderEmailVerifications").createIndex({ email: 1, checkoutAttemptId: 1, createdAt: -1 });
  await db.collection("orderEmailVerifications").createIndex({ verificationTokenHash: 1 }, { sparse: true });
  await db.collection("orderEmailVerifications").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
      { verifiedEmail: { $regex: pattern, $options: "i" } },
      { packageName: { $regex: pattern, $options: "i" } },
    ],
  };
}

export async function getNextOrderNumber(db, { counterId = "websiteOrders", startAt = 515 } = {}) {
  const now = new Date();
  const counters = db.collection("counters");
  await counters.updateOne(
    { _id: counterId },
    { $setOnInsert: { seq: startAt, createdAt: now } },
    { upsert: true },
  );
  const result = await counters.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 }, $set: { updatedAt: now } },
    { returnDocument: "after" },
  );
  const seq = result?.seq ?? result?.value?.seq;
  if (!Number.isInteger(seq)) throw new Error("Could not generate order number.");
  return `#${seq}`;
}

export function createOrderActivity({ employeeId, displayName, action, message, createdAt = new Date() }) {
  return {
    employeeId: employeeId || "system",
    displayName: displayName || "System",
    action: cleanString(action, 120),
    message: cleanString(message, 500),
    createdAt,
  };
}

export function createOrderEvent({ type, orderNumber, paymentProvider, paymentEventId, amountOre, currency = "SEK", message, createdAt = new Date() }) {
  if (!ORDER_EVENT_TYPES.includes(type)) throw new Error("Invalid order event type.");
  return {
    type,
    orderNumber: normalizeOrderNumber(orderNumber),
    paymentProvider: optional(paymentProvider, 80),
    paymentEventId: optional(paymentEventId, 180),
    amountOre: Number.isInteger(amountOre) ? amountOre : undefined,
    currency,
    message: optional(message, 500),
    createdAt,
  };
}

export function validateWebsiteOrderDraft(body) {
  const fields = {};
  const source = body && typeof body === "object" ? body : {};
  const packageId = cleanString(source.packageId, 80);
  const paymentOptionRaw = cleanString(source.paymentOption, 80);
  const customerName = cleanString(source.customerName, 160);
  const verifiedEmail = cleanString(source.verifiedEmail || source.email, 320).toLowerCase();
  const projectDescription = cleanString(source.projectDescription, 5000);
  const language = cleanString(source.customerLanguage || source.language, 8);
  const customerLanguage = ["en", "sv", "ar"].includes(language) ? language : "en";

  let packageItem = null;
  let paymentOption = "";
  try { packageItem = validateFixedPricePackage(packageId); }
  catch { fields.packageId = "Invalid package."; }
  try { paymentOption = normalizePaymentOption(paymentOptionRaw); }
  catch { fields.paymentOption = "Invalid payment option."; }
  if (!customerName) fields.customerName = "Customer name is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(verifiedEmail)) fields.verifiedEmail = "A verified customer email is required.";
  if (!projectDescription) fields.projectDescription = "Project description is required.";

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return {
    packageId: packageItem.packageId,
    paymentOption,
    customerName,
    companyName: optional(source.companyName, 180),
    email: verifiedEmail,
    verifiedEmail,
    phone: optional(source.phone, 80),
    projectDescription,
    requestedFeatures: cleanStringArray(source.requestedFeatures),
    websiteDetails: cleanObjectStrings(source.websiteDetails, [
      "businessName",
      "businessDescription",
      "websiteType",
      "pagesNeeded",
      "preferredStyle",
      "domainStatus",
      "logoStatus",
      "contentStatus",
      "additionalNotes",
    ]),
    customerLanguage,
  };
}

export function buildOrderDocumentFromVerifiedPayment(input, { orderNumber, paidAt = new Date() } = {}) {
  const draft = validateWebsiteOrderDraft(input);
  const priceSnapshot = createPriceSnapshot(draft.packageId, draft.paymentOption);
  const amounts = calculatePaymentAmounts(draft.packageId, draft.paymentOption);
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  if (!/^#\d+$/.test(normalizedOrderNumber)) throw new ValidationError({ orderNumber: "A valid generated order number is required." });

  const isFullPayment = amounts.remainingBalanceOre === 0;
  const paymentProvider = cleanString(input.paymentProvider, 80) || "pending-provider";
  const paymentEventId = cleanString(input.paymentEventId, 180);
  const paymentReference = cleanString(input.paymentReference, 180);
  const deliveryDate = input.deliveryDate ? new Date(input.deliveryDate) : null;
  const createdAt = new Date(paidAt);

  if (!paymentEventId) throw new ValidationError({ paymentEventId: "Verified payment event id is required." });
  const finalDeliveryDate = deliveryDate && !Number.isNaN(deliveryDate.getTime())
    ? deliveryDate
    : new Date(createdAt.getTime() + 14 * 24 * 60 * 60 * 1000);

  const paymentStatus = isFullPayment ? "Paid" : "Deposit Paid";
  const events = [
    createOrderEvent({
      type: isFullPayment ? "new_paid_order" : "deposit_received",
      orderNumber: normalizedOrderNumber,
      paymentProvider,
      paymentEventId,
      amountOre: amounts.amountDueNowOre,
      currency: amounts.currency,
      message: isFullPayment ? "Full payment received." : "Deposit payment received.",
      createdAt,
    }),
  ];

  return {
    orderNumber: normalizedOrderNumber,
    customerName: draft.customerName,
    companyName: draft.companyName || "",
    email: draft.email,
    verifiedEmail: draft.verifiedEmail,
    phone: draft.phone,
    projectType: priceSnapshot.packageName,
    service: "Website Design",
    packageId: priceSnapshot.packageId,
    packageName: priceSnapshot.packageName,
    package: priceSnapshot.packageName,
    price: formatSek(priceSnapshot.totalAmountOre),
    priceSnapshot,
    totalAmountOre: amounts.totalAmountOre,
    amountPaidOre: amounts.amountDueNowOre,
    remainingBalanceOre: amounts.remainingBalanceOre,
    currency: amounts.currency,
    paymentOption: amounts.paymentOption,
    paymentProvider,
    paymentEventId,
    paymentReference: paymentReference || undefined,
    paymentStatus,
    projectStatus: "Pending Review",
    reviewStatus: "pending_review",
    reviewedAt: null,
    reviewedBy: null,
    viewedBy: [],
    projectDescription: draft.projectDescription,
    requestedFeatures: draft.requestedFeatures,
    websiteDetails: draft.websiteDetails,
    customerLanguage: draft.customerLanguage,
    orderDate: createdAt,
    deliveryDate: finalDeliveryDate,
    isDemo: false,
    isPaidOrder: true,
    source: "payment_provider",
    internalNotes: "",
    activity: [
      createOrderActivity({
        action: "order_created",
        message: `System created ${normalizedOrderNumber} after verified ${paymentProvider} payment. Project is pending employee review.`,
        createdAt,
      }),
    ],
    events,
    notificationStatus: {},
    clarificationRequests: [],
    careEligibility: {
      eligible: true,
      reason: "paid_website_order",
    },
    createdAt,
    updatedAt: createdAt,
  };
}

export async function recordPaymentEventOnce(db, event) {
  try {
    await db.collection("paymentEvents").insertOne({
      provider: event.provider,
      eventId: event.eventId,
      type: event.type,
      receivedAt: event.receivedAt || new Date(),
      orderNumber: event.orderNumber,
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

export async function createOrderFromVerifiedPayment(db, input) {
  const provider = cleanString(input?.paymentProvider, 80);
  const eventId = cleanString(input?.paymentEventId, 180);
  if (!provider || !eventId) throw new ValidationError({ paymentProvider: "Payment provider and event id are required." });

  const eventWasNew = await recordPaymentEventOnce(db, { provider, eventId, type: "payment_confirmed" });
  if (!eventWasNew) {
    const existing = await db.collection("orders").findOne({ paymentProvider: provider, paymentEventId: eventId });
    return { created: false, order: existing };
  }

  const orderNumber = await getNextOrderNumber(db);
  const order = buildOrderDocumentFromVerifiedPayment(input, { orderNumber });
  await db.collection("orders").insertOne(order);
  await db.collection("paymentEvents").updateOne(
    { provider, eventId },
    { $set: { orderNumber: order.orderNumber, updatedAt: new Date() } },
  );
  return { created: true, order };
}

export function buildCareSubscriptionDraft(input) {
  const source = input && typeof input === "object" ? input : {};
  const planId = cleanString(source.planId, 80);
  const billingInterval = cleanString(source.billingInterval, 80);
  const orderNumber = normalizeOrderNumber(source.orderNumber);
  const customerEmail = cleanString(source.customerEmail || source.email, 320).toLowerCase();
  const fields = {};

  if (!CARE_PLAN_IDS.includes(planId)) fields.planId = "Invalid BlueMind Care plan.";
  if (!CARE_BILLING_INTERVALS.includes(billingInterval)) fields.billingInterval = "Invalid billing interval.";
  if (!/^#\d+$/.test(orderNumber)) fields.orderNumber = "A valid order number is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) fields.customerEmail = "A valid order email is required.";
  if (Object.keys(fields).length) throw new ValidationError(fields);

  return {
    planId,
    billingInterval,
    orderNumber,
    customerEmail,
    status: "pending_payment",
    ownershipVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function serializeOrder(order) {
  if (!order) return null;
  const activity = Array.isArray(order.activity)
    ? order.activity.map(item => ({
        employeeId: item.employeeId,
        displayName: item.displayName,
        action: item.action,
        message: item.message,
        createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      }))
    : [];

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
    packageId: order.packageId,
    packageName: order.packageName,
    price: order.price,
    priceSnapshot: order.priceSnapshot ? {
      ...order.priceSnapshot,
      capturedAt: order.priceSnapshot.capturedAt instanceof Date ? order.priceSnapshot.capturedAt.toISOString() : order.priceSnapshot.capturedAt,
    } : undefined,
    verifiedEmail: order.verifiedEmail,
    totalAmountOre: order.totalAmountOre,
    amountPaidOre: order.amountPaidOre,
    remainingBalanceOre: order.remainingBalanceOre,
    currency: order.currency,
    paymentOption: order.paymentOption,
    paymentProvider: order.paymentProvider,
    paymentReference: order.paymentReference,
    paymentStatus: order.paymentStatus,
    projectStatus: order.projectStatus,
    reviewStatus: order.reviewStatus || (order.projectStatus === "Confirmed" ? "confirmed" : "pending_review"),
    reviewedAt: order.reviewedAt instanceof Date ? order.reviewedAt.toISOString() : order.reviewedAt,
    reviewedBy: order.reviewedBy,
    viewedBy: Array.isArray(order.viewedBy)
      ? order.viewedBy.map(item => ({
          ...item,
          viewedAt: item.viewedAt instanceof Date ? item.viewedAt.toISOString() : item.viewedAt,
        }))
      : [],
    orderDate: order.orderDate instanceof Date ? order.orderDate.toISOString() : order.orderDate,
    deliveryDate: order.deliveryDate instanceof Date ? order.deliveryDate.toISOString() : order.deliveryDate,
    projectDescription: order.projectDescription,
    requestedFeatures: Array.isArray(order.requestedFeatures) ? order.requestedFeatures : [],
    websiteDetails: order.websiteDetails || {},
    internalNotes: order.internalNotes || "",
    customerLanguage: order.customerLanguage || "en",
    notificationStatus: order.notificationStatus || {},
    clarificationRequests: Array.isArray(order.clarificationRequests)
      ? order.clarificationRequests.map(item => ({
          ...item,
          createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
        }))
      : [],
    activity,
    events: Array.isArray(order.events)
      ? order.events.map(item => ({
          ...item,
          createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
        }))
      : [],
    careEligibility: order.careEligibility,
    isDemo: Boolean(order.isDemo),
    isPaidOrder: Boolean(order.isPaidOrder),
    createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
    updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt,
  };
}

export function createTestOrder() {
  const doc = validateOrderDocument({
    orderNumber: "#515",
    customerName: "Ahmed Example",
    companyName: "Example Company",
    email: "demo.customer@example.com",
    phone: "+46 70 000 00 15",
    projectType: "E-commerce Website",
    service: "Online Store",
    packageId: "online-store",
    packageName: "Online Store",
    package: "Business / Store package",
    price: "12 990 SEK",
    paymentStatus: "Paid",
    projectStatus: "New",
    orderDate: "2026-10-06T00:00:00.000Z",
    deliveryDate: "2026-10-25T00:00:00.000Z",
    projectDescription: "Safe demo order for testing the BlueMind internal admin dashboard.",
    internalNotes: "Demo data only. Do not treat as a real customer order.",
  });
  return {
    ...doc,
    totalAmountOre: 1299000,
    amountPaidOre: 1299000,
    remainingBalanceOre: 0,
    currency: "SEK",
    paymentOption: "full",
    paymentProvider: "demo",
    isDemo: true,
    isPaidOrder: false,
    source: "demo",
    verifiedEmail: doc.email,
    requestedFeatures: ["Online Store", "Payments", "Contact Form"],
    websiteDetails: {
      businessName: "Example Company",
      websiteType: "Online store",
    },
    activity: [
      createOrderActivity({
        action: "demo_order_seeded",
        message: "System created safe demo order #515 for admin testing.",
        createdAt: doc.createdAt,
      }),
    ],
    events: [],
    careEligibility: {
      eligible: false,
      reason: "demo_order",
    },
  };
}
