import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createOrderFromVerifiedPayment, serializeOrder, validateWebsiteOrderDraft } from "./orders.js";
import { calculatePaymentAmounts, formatSek, PAYMENT_OPTIONS } from "./pricing.js";
import { sendInitialOrderNotifications } from "./orderNotifications.js";
import { verifyEmailToken } from "./emailVerification.js";

export const STRIPE_PRODUCT_IDS = {
  "bluemind-test-package": "prod_VP2p2OZHU1Eiui",
};

export const STRIPE_PRICE_IDS = {
  "one-page-website": {
    full: "price_1UOBpgIO0JggS4KFPhchQ8wi",
    deposit: "price_1UOBqLIO0JggS4KFWH9TbCFO",
  },
  "small-website": {
    full: "price_1UOBpqIO0JggS4KFwRdMBOPa",
    deposit: "price_1UOBqSIO0JggS4KFROp3PvDj",
  },
  "business-website": {
    full: "price_1UOBpwIO0JggS4KFmwOGdoI8",
    deposit: "price_1UOBqYIO0JggS4KFdhsiWNGM",
  },
  "business-plus": {
    full: "price_1UOBq3IO0JggS4KFnyz9YNyV",
    deposit: "price_1UOBqeIO0JggS4KFWPqatEaO",
  },
  "online-store": {
    full: "price_1UOBq9IO0JggS4KF8edENRhP",
    deposit: "price_1UOBqlIO0JggS4KFxaTaFXDp",
  },
  "bluemind-test-package": {
    full: "price_1UOEk9IO0JggS4KF8za1GpDy",
  },
};

const stripeClients = new Map();

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function getStripe(env) {
  const key = cleanString(env.STRIPE_SECRET_KEY, 300);
  if (!key) throw Object.assign(new Error("Stripe is not configured."), { statusCode: 503 });
  if (key.startsWith("sk_live_")) throw Object.assign(new Error("Live Stripe keys are not allowed for this test-mode integration."), { statusCode: 503 });
  if (!stripeClients.has(key)) {
    stripeClients.set(key, new Stripe(key, { apiVersion: "2025-09-30.clover" }));
  }
  return stripeClients.get(key);
}

export function getStripePriceId(packageId, paymentOption) {
  const entry = STRIPE_PRICE_IDS[packageId];
  const option = paymentOption === PAYMENT_OPTIONS.DEPOSIT ? PAYMENT_OPTIONS.DEPOSIT : PAYMENT_OPTIONS.FULL;
  const priceId = entry?.[option];
  if (!priceId) throw Object.assign(new Error("Package is not configured for Stripe Checkout."), { statusCode: 400 });
  return priceId;
}

export function buildCheckoutDraft(body) {
  const draft = validateWebsiteOrderDraft({
    packageId: body?.packageId,
    paymentOption: body?.paymentOption,
    customerName: body?.customerName || body?.websiteDetails?.businessName || "BlueMind customer",
    companyName: body?.companyName,
    verifiedEmail: body?.verifiedEmail || body?.email,
    phone: body?.phone,
    projectDescription: body?.projectDescription || body?.websiteDetails?.additionalNotes,
    requestedFeatures: body?.requestedFeatures,
    websiteDetails: body?.websiteDetails,
    customerLanguage: body?.customerLanguage || body?.language,
  });
  const amounts = calculatePaymentAmounts(draft.packageId, draft.paymentOption);
  const priceId = getStripePriceId(draft.packageId, draft.paymentOption);
  return { ...draft, amounts, stripePriceId: priceId };
}

function getFrontendBaseUrl(env) {
  const configured = cleanString(env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL, 300).replace(/\/$/, "");
  if (configured) return configured;
  return "https://bluemind-web-service.vercel.app";
}

export async function createStripeCheckoutSession({ env, db, body }) {
  const draft = buildCheckoutDraft(body);
  const emailVerification = await verifyEmailToken(db, {
    email: draft.verifiedEmail,
    checkoutAttemptId: body?.checkoutAttemptId,
    token: body?.emailVerificationToken,
  });
  const stripe = getStripe(env);
  const pendingCheckoutId = randomUUID();
  const frontendBase = getFrontendBaseUrl(env);
  const now = new Date();
  const checkoutDoc = {
    _id: pendingCheckoutId,
    provider: "stripe",
    status: "pending",
    packageId: draft.packageId,
    packageName: draft.amounts.packageName,
    paymentOption: draft.paymentOption,
    totalAmountOre: draft.amounts.totalAmountOre,
    amountDueNowOre: draft.amounts.amountDueNowOre,
    remainingBalanceOre: draft.amounts.remainingBalanceOre,
    currency: draft.amounts.currency,
    customerName: draft.customerName,
    companyName: draft.companyName || "",
    email: draft.verifiedEmail,
    verifiedEmail: draft.verifiedEmail,
    emailVerificationId: emailVerification.verificationId,
    checkoutAttemptId: emailVerification.checkoutAttemptId,
    phone: draft.phone,
    projectDescription: draft.projectDescription,
    requestedFeatures: draft.requestedFeatures,
    websiteDetails: draft.websiteDetails,
    customerLanguage: draft.customerLanguage,
    stripePriceId: draft.stripePriceId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("checkoutSessions").insertOne(checkoutDoc);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: draft.verifiedEmail,
    line_items: [{ price: draft.stripePriceId, quantity: 1 }],
    success_url: `${frontendBase}/quote?checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBase}/quote?checkout_cancelled=1`,
    client_reference_id: pendingCheckoutId,
    metadata: {
      pendingCheckoutId,
      packageId: draft.packageId,
      paymentOption: draft.paymentOption,
      expectedAmountOre: String(draft.amounts.amountDueNowOre),
      currency: draft.amounts.currency,
      testOnly: draft.packageId === "bluemind-test-package" ? "true" : "false",
    },
    payment_intent_data: {
      metadata: {
        pendingCheckoutId,
        packageId: draft.packageId,
        paymentOption: draft.paymentOption,
        testOnly: draft.packageId === "bluemind-test-package" ? "true" : "false",
      },
    },
  });

  await db.collection("checkoutSessions").updateOne(
    { _id: pendingCheckoutId },
    { $set: { stripeSessionId: session.id, stripeUrl: session.url, updatedAt: new Date() } },
  );

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
    packageId: draft.packageId,
    paymentOption: draft.paymentOption,
    totalAmountOre: draft.amounts.totalAmountOre,
    amountDueNowOre: draft.amounts.amountDueNowOre,
    remainingBalanceOre: draft.amounts.remainingBalanceOre,
    currency: draft.amounts.currency,
  };
}

export function constructStripeEvent(env, rawBody, signature) {
  const secret = cleanString(env.STRIPE_WEBHOOK_SECRET, 300);
  if (!secret) throw Object.assign(new Error("Stripe webhook is not configured."), { statusCode: 503 });
  return getStripe(env).webhooks.constructEvent(rawBody, signature, secret);
}

async function markPendingCheckout(db, stripeSessionId, update) {
  await db.collection("checkoutSessions").updateOne(
    { stripeSessionId },
    { $set: { ...update, updatedAt: new Date() } },
  );
}

async function createOrderForPaidSession({ env, db, event, session }) {
  if (session.payment_status !== "paid") {
    await markPendingCheckout(db, session.id, { status: session.payment_status || "unpaid", stripeEventId: event.id });
    return { action: "ignored", reason: "payment_not_paid" };
  }

  const pendingCheckoutId = session.metadata?.pendingCheckoutId || session.client_reference_id;
  const pending = pendingCheckoutId
    ? await db.collection("checkoutSessions").findOne({ _id: pendingCheckoutId })
    : await db.collection("checkoutSessions").findOne({ stripeSessionId: session.id });

  if (!pending) {
    await db.collection("paymentEvents").updateOne(
      { provider: "stripe", eventId: session.id },
      { $setOnInsert: { provider: "stripe", eventId: session.id, type: "orphan_paid_session", receivedAt: new Date() } },
      { upsert: true },
    );
    return { action: "ignored", reason: "pending_checkout_not_found" };
  }

  const expected = calculatePaymentAmounts(pending.packageId, pending.paymentOption);
  if (session.currency?.toUpperCase() !== expected.currency || session.amount_total !== expected.amountDueNowOre) {
    await markPendingCheckout(db, session.id, { status: "amount_mismatch", stripeEventId: event.id });
    throw new Error("Stripe session amount did not match the server-side package price.");
  }

  const result = await createOrderFromVerifiedPayment(db, {
    packageId: pending.packageId,
    paymentOption: pending.paymentOption,
    customerName: pending.customerName,
    companyName: pending.companyName,
    verifiedEmail: pending.verifiedEmail,
    email: pending.verifiedEmail,
    phone: pending.phone,
    projectDescription: pending.projectDescription,
    requestedFeatures: pending.requestedFeatures,
    websiteDetails: pending.websiteDetails,
    customerLanguage: pending.customerLanguage,
    paymentProvider: "stripe",
    paymentEventId: session.id,
    paymentReference: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
  });

  if (result.order) {
    await markPendingCheckout(db, session.id, {
      status: "confirmed",
      stripeEventId: event.id,
      orderNumber: result.order.orderNumber,
      orderId: result.order._id,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    });

    if (result.created) {
      try {
        await sendInitialOrderNotifications(env, db, result.order);
      } catch (error) {
        console.error("Order payment email failed", { orderNumber: result.order.orderNumber, message: error?.message });
      }
    }
  }

  return { action: result.created ? "created" : "duplicate", order: result.order };
}

export async function handleStripeWebhookEvent({ env, db, event }) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return await createOrderForPaidSession({ env, db, event, session: event.data.object });
    case "checkout.session.async_payment_failed":
      await markPendingCheckout(db, event.data.object.id, { status: "payment_failed", stripeEventId: event.id });
      return { action: "marked_failed" };
    case "checkout.session.expired":
      await markPendingCheckout(db, event.data.object.id, { status: "expired", stripeEventId: event.id });
      return { action: "marked_expired" };
    default:
      return { action: "ignored", reason: "unhandled_event" };
  }
}

export async function getStripeCheckoutStatus({ db, sessionId }) {
  const cleanSessionId = cleanString(sessionId, 200);
  if (!cleanSessionId) throw Object.assign(new Error("Missing checkout session id."), { statusCode: 400 });
  const pending = await db.collection("checkoutSessions").findOne({ stripeSessionId: cleanSessionId });
  if (!pending) return { status: "not_found" };
  const order = pending.orderNumber
    ? await db.collection("orders").findOne({ orderNumber: pending.orderNumber })
    : null;
  return {
    status: pending.status || "pending",
    sessionId: cleanSessionId,
    order: order ? serializeOrder(order) : null,
    amounts: {
      total: formatSek(pending.totalAmountOre),
      paid: formatSek(pending.amountDueNowOre),
      remaining: formatSek(pending.remainingBalanceOre),
    },
  };
}
