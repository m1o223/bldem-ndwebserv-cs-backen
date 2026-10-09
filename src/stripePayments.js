import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createOrderFromVerifiedPayment, serializeOrder, validateWebsiteOrderDraft } from "./orders.js";
import { calculatePaymentAmounts, formatSek, normalizePaymentOption, PAYMENT_OPTIONS } from "./pricing.js";
import { sendInitialOrderNotifications } from "./orderNotifications.js";
import { verifyEmailToken } from "./emailVerification.js";

export const STRIPE_PRODUCT_IDS = {
  "bluemind-test-package": "prod_VP2p2OZHU1Eiui",
};

export const STRIPE_PRICE_IDS = {
  "one-page-website": {
    full: "price_1UOBpgIO0JggS4KFPhchQ8wi",
    deposit_50: "price_1UOBqLIO0JggS4KFWH9TbCFO",
  },
  "small-website": {
    full: "price_1UOBpqIO0JggS4KFwRdMBOPa",
    deposit_50: "price_1UOBqSIO0JggS4KFROp3PvDj",
  },
  "business-website": {
    full: "price_1UOBpwIO0JggS4KFmwOGdoI8",
    deposit_50: "price_1UOBqYIO0JggS4KFdhsiWNGM",
  },
  "business-plus": {
    full: "price_1UOBq3IO0JggS4KFnyz9YNyV",
    deposit_50: "price_1UOBqeIO0JggS4KFWPqatEaO",
  },
  "online-store": {
    full: "price_1UOBq9IO0JggS4KF8edENRhP",
    deposit_50: "price_1UOBqlIO0JggS4KFxaTaFXDp",
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

export const CHECKOUT_PAYMENT_METHODS = {
  CARD: "card",
  VISA: "visa",
  MASTERCARD: "mastercard",
  APPLE_PAY: "apple-pay",
  GOOGLE_PAY: "google-pay",
  PAYPAL: "paypal",
  KLARNA: "klarna",
};

function flagEnabled(value) {
  return /^(1|true|yes|on)$/i.test(cleanString(value, 20));
}

export function resolveCheckoutPaymentMethod(value, env = {}) {
  const selected = cleanString(value || CHECKOUT_PAYMENT_METHODS.CARD, 40).toLowerCase();
  if ([CHECKOUT_PAYMENT_METHODS.CARD, CHECKOUT_PAYMENT_METHODS.VISA, CHECKOUT_PAYMENT_METHODS.MASTERCARD].includes(selected)) {
    return {
      id: selected,
      providerType: "card",
      displayName: selected === CHECKOUT_PAYMENT_METHODS.MASTERCARD ? "Mastercard" : selected === CHECKOUT_PAYMENT_METHODS.VISA ? "Visa" : "Card",
      stripePaymentMethodTypes: ["card"],
    };
  }
  if (selected === CHECKOUT_PAYMENT_METHODS.KLARNA) {
    if (!flagEnabled(env.ENABLE_STRIPE_KLARNA_CHECKOUT)) {
      throw Object.assign(new Error("Klarna is not available for BlueMind Stripe Sandbox checkout yet. Please choose card payment."), { statusCode: 400 });
    }
    return {
      id: selected,
      providerType: "klarna",
      displayName: "Klarna",
      stripePaymentMethodTypes: ["klarna"],
    };
  }
  if (selected === CHECKOUT_PAYMENT_METHODS.PAYPAL) {
    if (!flagEnabled(env.ENABLE_STRIPE_PAYPAL_CHECKOUT)) {
      throw Object.assign(new Error("PayPal is not integrated for BlueMind Stripe Sandbox checkout yet. Please choose card payment."), { statusCode: 400 });
    }
    return {
      id: selected,
      providerType: "paypal",
      displayName: "PayPal",
      stripePaymentMethodTypes: ["paypal"],
    };
  }
  if (selected === CHECKOUT_PAYMENT_METHODS.APPLE_PAY || selected === CHECKOUT_PAYMENT_METHODS.GOOGLE_PAY) {
    throw Object.assign(new Error("Apple Pay and Google Pay are card wallets in Stripe Checkout and cannot be isolated as a single hosted Checkout method here. Please choose card payment, or use a compatible wallet if Stripe shows it on your device."), { statusCode: 400 });
  }
  throw Object.assign(new Error("Invalid payment method."), { statusCode: 400 });
}

export function getStripe(env) {
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
  const option = normalizePaymentOption(paymentOption);
  if (option === PAYMENT_OPTIONS.DEPOSIT_25) {
    throw Object.assign(new Error("25% deposits use a server-calculated Stripe Checkout amount."), { statusCode: 400 });
  }
  const priceId = entry?.[option];
  if (!priceId) throw Object.assign(new Error("Package is not configured for Stripe Checkout."), { statusCode: 400 });
  return priceId;
}

export function buildStripeLineItem(draft) {
  if (draft.paymentOption !== PAYMENT_OPTIONS.DEPOSIT_25) {
    return { price: draft.stripePriceId, quantity: 1 };
  }

  return {
    quantity: 1,
    price_data: {
      currency: draft.amounts.currency.toLowerCase(),
      unit_amount: draft.amounts.amountDueNowOre,
      product_data: {
        name: `${draft.amounts.packageName} - 25% Deposit`,
        metadata: {
          packageId: draft.packageId,
          paymentOption: draft.paymentOption,
        },
      },
    },
  };
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
  const priceId = draft.paymentOption === PAYMENT_OPTIONS.DEPOSIT_25
    ? null
    : getStripePriceId(draft.packageId, draft.paymentOption);
  return { ...draft, amounts, stripePriceId: priceId };
}

export function buildCheckoutSessionParams({ draft, frontendBase, pendingCheckoutId, selectedPaymentMethod }) {
  return {
    mode: "payment",
    customer_email: draft.verifiedEmail,
    payment_method_types: selectedPaymentMethod.stripePaymentMethodTypes,
    line_items: [buildStripeLineItem(draft)],
    success_url: `${frontendBase}/quote?checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBase}/quote?checkout_cancelled=1`,
    client_reference_id: pendingCheckoutId,
    metadata: {
      pendingCheckoutId,
      packageId: draft.packageId,
      paymentOption: draft.paymentOption,
      selectedPaymentMethod: selectedPaymentMethod.id,
      stripePaymentMethodType: selectedPaymentMethod.providerType,
      expectedAmountOre: String(draft.amounts.amountDueNowOre),
      currency: draft.amounts.currency,
      testOnly: draft.packageId === "bluemind-test-package" ? "true" : "false",
    },
    payment_intent_data: {
      metadata: {
        pendingCheckoutId,
        packageId: draft.packageId,
        paymentOption: draft.paymentOption,
        selectedPaymentMethod: selectedPaymentMethod.id,
        stripePaymentMethodType: selectedPaymentMethod.providerType,
        testOnly: draft.packageId === "bluemind-test-package" ? "true" : "false",
      },
    },
  };
}

function getFrontendBaseUrl(env) {
  const configured = cleanString(env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL, 300).replace(/\/$/, "");
  if (configured) return configured;
  return "https://bluemind-web-service.vercel.app";
}

export async function createStripeCheckoutSession({ env, db, body }) {
  const draft = buildCheckoutDraft(body);
  const selectedPaymentMethod = resolveCheckoutPaymentMethod(body?.paymentMethod, env);
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
    selectedPaymentMethod: selectedPaymentMethod.id,
    stripePaymentMethodType: selectedPaymentMethod.providerType,
    paymentMethodDisplayName: selectedPaymentMethod.displayName,
    stripePriceId: draft.stripePriceId || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("checkoutSessions").insertOne(checkoutDoc);

  const session = await stripe.checkout.sessions.create(buildCheckoutSessionParams({
    draft,
    frontendBase,
    pendingCheckoutId,
    selectedPaymentMethod,
  }));

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
    selectedPaymentMethod: selectedPaymentMethod.id,
    stripePaymentMethodType: selectedPaymentMethod.providerType,
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
    selectedPaymentMethod: pending.selectedPaymentMethod,
    stripePaymentMethodType: pending.stripePaymentMethodType,
    paymentMethodDisplayName: pending.paymentMethodDisplayName,
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
