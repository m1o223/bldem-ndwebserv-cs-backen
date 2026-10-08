import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import {
  calculateCarePrice,
  formatSekFromOre,
  getCarePlan,
  getCareStripePriceId,
  normalizeCareBillingInterval,
} from "./carePricing.js";
import { verifyEmailToken } from "./emailVerification.js";
import { sendCareSubscriptionEmails } from "./email.js";
import { createOrderActivity, normalizeOrderNumber } from "./orders.js";
import { getStripe } from "./stripePayments.js";
import { ValidationError } from "./validation.js";

const MANAGE_REASONS = new Set(["too_expensive", "no_longer_needed", "not_satisfied", "switching_providers", "other"]);
const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due", "incomplete"]);

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function dateFromStripeSeconds(value) {
  return Number.isFinite(value) ? new Date(value * 1000) : null;
}

function getFrontendBaseUrl(env) {
  const configured = cleanString(env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL, 300).replace(/\/$/, "");
  return configured || "https://bluemind-web-service.vercel.app";
}

function customerNameFromOrder(order) {
  return cleanString(order?.customerName, 160) || cleanString(order?.websiteDetails?.businessName, 160) || "BlueMind customer";
}

export function buildCareCheckoutDraft(input) {
  const source = input && typeof input === "object" ? input : {};
  const plan = getCarePlan(source.planId);
  const billingInterval = normalizeCareBillingInterval(source.billingInterval);
  const orderNumber = normalizeOrderNumber(source.orderNumber);
  const customerEmail = normalizeEmail(source.customerEmail || source.email);
  const fields = {};
  if (!/^#\d+$/.test(orderNumber)) fields.orderNumber = "A valid order number is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) fields.customerEmail = "A valid order email is required.";
  if (Object.keys(fields).length) throw new ValidationError(fields);
  const testMode = source.testMode === true || source.testMode === "true";
  const price = calculateCarePrice(plan.planId, billingInterval, { testMode });
  return { plan, billingInterval, orderNumber, customerEmail, testMode, price };
}

async function verifyCareOrderOwnership(db, draft) {
  const order = await db.collection("orders").findOne({ orderNumber: draft.orderNumber });
  if (!order) throw Object.assign(new Error("We could not find that BlueMind website order."), { statusCode: 404 });
  const orderEmail = normalizeEmail(order.verifiedEmail || order.email);
  if (orderEmail !== draft.customerEmail) throw Object.assign(new Error("We could not match this order number with this email."), { statusCode: 403 });

  const isAllowedTestOrder = draft.testMode && (order.isDemo || order.isSandboxTestOrder || order.orderNumber === "#515");
  const eligible = order.isPaidOrder && order.careEligibility?.eligible !== false && !order.isSandboxTestOrder;
  if (!eligible && !isAllowedTestOrder) {
    throw Object.assign(new Error("This order is not eligible for BlueMind Care yet."), { statusCode: 400 });
  }
  return order;
}

async function assertNoDuplicateActiveSubscription(db, draft) {
  const existing = await db.collection("careSubscriptions").findOne({
    orderNumber: draft.orderNumber,
    planId: draft.plan.planId,
    testMode: Boolean(draft.testMode),
    status: { $in: [...ACTIVE_STRIPE_STATUSES, "active_until_period_end"] },
  });
  if (existing && !existing.cancelAtPeriodEnd) {
    throw Object.assign(new Error("This website already has an active subscription for that Care plan."), { statusCode: 409 });
  }
}

export async function createCareStripeCheckoutSession({ env, db, body }) {
  const draft = buildCareCheckoutDraft(body);
  const verification = await verifyEmailToken(db, {
    email: draft.customerEmail,
    checkoutAttemptId: body?.checkoutAttemptId,
    token: body?.emailVerificationToken,
  });
  const order = await verifyCareOrderOwnership(db, draft);
  await assertNoDuplicateActiveSubscription(db, draft);

  const stripe = getStripe(env);
  const careCheckoutId = randomUUID();
  const priceId = getCareStripePriceId(draft.plan.planId, draft.billingInterval, { testMode: draft.testMode });
  const frontendBase = getFrontendBaseUrl(env);
  const now = new Date();
  const doc = {
    _id: careCheckoutId,
    provider: "stripe",
    kind: "care_subscription",
    status: "pending",
    planId: draft.plan.planId,
    planName: draft.plan.name,
    billingInterval: draft.billingInterval,
    orderNumber: draft.orderNumber,
    websiteOrderId: order._id,
    customerName: customerNameFromOrder(order),
    customerEmail: draft.customerEmail,
    emailVerificationId: verification.verificationId,
    checkoutAttemptId: verification.checkoutAttemptId,
    amountOre: draft.price.amountOre,
    currency: draft.price.currency,
    testMode: draft.testMode,
    stripePriceId: priceId,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection("careSubscriptionCheckouts").insertOne(doc);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: draft.customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendBase}/care?care_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBase}/care?care_cancelled=1`,
    client_reference_id: careCheckoutId,
    metadata: {
      kind: "care_subscription",
      careCheckoutId,
      planId: draft.plan.planId,
      billingInterval: draft.billingInterval,
      orderNumber: draft.orderNumber,
      testMode: draft.testMode ? "true" : "false",
    },
    subscription_data: {
      metadata: {
        kind: "care_subscription",
        careCheckoutId,
        planId: draft.plan.planId,
        billingInterval: draft.billingInterval,
        orderNumber: draft.orderNumber,
        testMode: draft.testMode ? "true" : "false",
      },
    },
  });

  await db.collection("careSubscriptionCheckouts").updateOne(
    { _id: careCheckoutId },
    { $set: { stripeSessionId: session.id, stripeUrl: session.url, updatedAt: new Date() } },
  );

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
    planId: draft.plan.planId,
    planName: draft.plan.name,
    billingInterval: draft.billingInterval,
    amountOre: draft.price.amountOre,
    currency: draft.price.currency,
    testMode: draft.testMode,
  };
}

async function recordStripeCareEventOnce(db, event) {
  try {
    await db.collection("paymentEvents").insertOne({
      provider: "stripe",
      eventId: event.id,
      type: event.type,
      receivedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

function buildSubscriptionDoc({ checkout, subscription, session, event, existing }) {
  const now = new Date();
  const { _id: _existingId, ...existingFields } = existing || {};
  const currentPeriodStart = dateFromStripeSeconds(subscription.current_period_start);
  const currentPeriodEnd = dateFromStripeSeconds(subscription.current_period_end);
  const cancelAt = dateFromStripeSeconds(subscription.cancel_at);
  const canceledAt = dateFromStripeSeconds(subscription.canceled_at);
  const status = subscription.cancel_at_period_end && subscription.status === "active" ? "active_until_period_end" : subscription.status;
  return {
    ...existingFields,
    provider: "stripe",
    kind: "care_subscription",
    orderNumber: checkout.orderNumber,
    websiteOrderId: checkout.websiteOrderId,
    customerName: checkout.customerName,
    customerEmail: checkout.customerEmail,
    planId: checkout.planId,
    planName: checkout.planName,
    billingInterval: checkout.billingInterval,
    amountOre: checkout.amountOre,
    currency: checkout.currency,
    testMode: Boolean(checkout.testMode),
    status,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    stripeSubscriptionId: subscription.id,
    stripeCheckoutSessionId: session?.id || checkout.stripeSessionId,
    stripePriceId: checkout.stripePriceId,
    latestInvoiceId: typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id,
    currentPeriodStart,
    currentPeriodEnd,
    paidThroughDate: currentPeriodEnd,
    nextRenewalDate: subscription.cancel_at_period_end ? null : currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt,
    canceledAt,
    lastStripeEventId: event.id,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
    activity: [
      ...(Array.isArray(existing?.activity) ? existing.activity : []),
      {
        employeeId: "system",
        displayName: "System",
        action: existing ? "care_subscription_synced" : "care_subscription_activated",
        message: existing
          ? `System synchronized BlueMind Care subscription ${subscription.id}.`
          : `System activated ${checkout.planName} for ${checkout.orderNumber} after verified Stripe subscription payment.`,
        createdAt: now,
      },
    ],
  };
}

async function sendTrackedCareEmails(env, db, subscription, options = {}) {
  const action = options.action || "activated";
  const dedupeKey = `${subscription.stripeSubscriptionId}:${action}`;
  const filter = { subscriptionId: subscription.stripeSubscriptionId, type: `care_${action}`, dedupeKey };
  const existing = await db.collection("careNotifications").findOne(filter);
  if (existing?.status === "sent") return { sent: false, skipped: true, reason: "already_sent" };

  await db.collection("careNotifications").updateOne(
    filter,
    { $setOnInsert: { ...filter, status: "queued", createdAt: new Date() }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
  try {
    const result = await sendCareSubscriptionEmails(env, subscription, { action });
    await db.collection("careNotifications").updateOne(filter, { $set: { status: "sent", result, sentAt: new Date(), updatedAt: new Date() } });
    return { sent: true, result };
  } catch (error) {
    await db.collection("careNotifications").updateOne(filter, {
      $set: { status: "failed", error: cleanString(error?.message, 400), updatedAt: new Date() },
    });
    console.error("Care subscription email failed", { subscriptionId: subscription.stripeSubscriptionId, action, message: error?.message });
    return { sent: false, reason: "failed" };
  }
}

async function activateCareFromCheckout({ env, db, event, session }) {
  if (session.mode !== "subscription") return { action: "ignored", reason: "not_subscription_session" };
  const careCheckoutId = session.metadata?.careCheckoutId || session.client_reference_id;
  const checkout = careCheckoutId
    ? await db.collection("careSubscriptionCheckouts").findOne({ _id: careCheckoutId })
    : await db.collection("careSubscriptionCheckouts").findOne({ stripeSessionId: session.id });
  if (!checkout) return { action: "ignored", reason: "care_checkout_not_found" };
  if (!session.subscription) {
    await db.collection("careSubscriptionCheckouts").updateOne({ _id: checkout._id }, { $set: { status: "missing_subscription", updatedAt: new Date() } });
    return { action: "ignored", reason: "missing_subscription" };
  }

  const stripe = getStripe(env);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const existing = await db.collection("careSubscriptions").findOne({ stripeSubscriptionId: subscription.id });
  const doc = buildSubscriptionDoc({ checkout, subscription, session, event, existing });
  await db.collection("careSubscriptions").updateOne(
    { stripeSubscriptionId: subscription.id },
    { $set: doc, $setOnInsert: { _id: existing?._id || randomUUID() } },
    { upsert: true },
  );
  await db.collection("careSubscriptionCheckouts").updateOne(
    { _id: checkout._id },
    { $set: { status: "confirmed", stripeSubscriptionId: subscription.id, stripeEventId: event.id, updatedAt: new Date() } },
  );
  await db.collection("orders").updateOne(
    { orderNumber: checkout.orderNumber },
    {
      $push: {
        activity: createOrderActivity({
          action: "care_subscription_activated",
          message: `BlueMind Care ${checkout.planName} was activated for this order.`,
        }),
      },
      $set: { updatedAt: new Date() },
    },
  );
  if (!existing) await sendTrackedCareEmails(env, db, doc, { action: "activated" });
  return { action: existing ? "synced" : "created", subscriptionId: subscription.id };
}

async function syncSubscription({ env, db, event, subscription }) {
  const existing = await db.collection("careSubscriptions").findOne({ stripeSubscriptionId: subscription.id });
  if (!existing) return { action: "ignored", reason: "subscription_not_found" };
  const doc = buildSubscriptionDoc({ checkout: existing, subscription, session: null, event, existing });
  await db.collection("careSubscriptions").updateOne({ stripeSubscriptionId: subscription.id }, { $set: doc });
  return { action: "synced", subscriptionId: subscription.id };
}

async function syncSubscriptionById({ env, db, event, subscriptionId }) {
  const cleanId = cleanString(subscriptionId, 200);
  if (!cleanId) return { action: "ignored", reason: "missing_subscription_id" };
  const stripe = getStripe(env);
  const subscription = await stripe.subscriptions.retrieve(cleanId);
  return await syncSubscription({ env, db, event, subscription });
}

export async function handleCareStripeWebhookEvent({ env, db, event }) {
  const isNew = await recordStripeCareEventOnce(db, event);
  if (!isNew) return { action: "duplicate_ignored", eventId: event.id };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return await activateCareFromCheckout({ env, db, event, session: event.data.object });
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return await syncSubscription({ env, db, event, subscription: event.data.object });
    case "invoice.paid":
    case "invoice.payment_failed":
      return await syncSubscriptionById({ env, db, event, subscriptionId: event.data.object?.subscription });
    default:
      return { action: "ignored", reason: "unhandled_care_event" };
  }
}

export async function getCareCheckoutStatus({ db, sessionId }) {
  const cleanSessionId = cleanString(sessionId, 200);
  if (!cleanSessionId) throw Object.assign(new Error("Missing Care checkout session id."), { statusCode: 400 });
  const checkout = await db.collection("careSubscriptionCheckouts").findOne({ stripeSessionId: cleanSessionId });
  if (!checkout) return { status: "not_found" };
  const subscription = checkout.stripeSubscriptionId
    ? await db.collection("careSubscriptions").findOne({ stripeSubscriptionId: checkout.stripeSubscriptionId })
    : null;
  return {
    status: checkout.status || "pending",
    sessionId: cleanSessionId,
    subscription: serializeCareSubscription(subscription),
  };
}

export function serializeCareSubscription(subscription) {
  if (!subscription) return null;
  return {
    id: String(subscription._id),
    orderNumber: subscription.orderNumber,
    customerName: subscription.customerName,
    customerEmail: subscription.customerEmail,
    planId: subscription.planId,
    planName: subscription.planName,
    billingInterval: subscription.billingInterval,
    price: formatSekFromOre(subscription.amountOre),
    amountOre: subscription.amountOre,
    currency: subscription.currency,
    status: subscription.status,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart instanceof Date ? subscription.currentPeriodStart.toISOString() : subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd instanceof Date ? subscription.currentPeriodEnd.toISOString() : subscription.currentPeriodEnd,
    paidThroughDate: subscription.paidThroughDate instanceof Date ? subscription.paidThroughDate.toISOString() : subscription.paidThroughDate,
    nextRenewalDate: subscription.nextRenewalDate instanceof Date ? subscription.nextRenewalDate.toISOString() : subscription.nextRenewalDate,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    cancellation: subscription.cancellation,
    testMode: Boolean(subscription.testMode),
    activity: Array.isArray(subscription.activity)
      ? subscription.activity.map(item => ({ ...item, createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt }))
      : [],
    createdAt: subscription.createdAt instanceof Date ? subscription.createdAt.toISOString() : subscription.createdAt,
    updatedAt: subscription.updatedAt instanceof Date ? subscription.updatedAt.toISOString() : subscription.updatedAt,
  };
}

export async function listCareSubscriptionsForVerifiedEmail({ db, email, checkoutAttemptId, token }) {
  const verification = await verifyEmailToken(db, { email, checkoutAttemptId, token });
  const subscriptions = await db.collection("careSubscriptions")
    .find({ customerEmail: verification.email })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return { email: verification.email, subscriptions: subscriptions.map(serializeCareSubscription) };
}

export async function cancelCareSubscription({ env, db, body }) {
  const email = normalizeEmail(body?.email);
  const verification = await verifyEmailToken(db, { email, checkoutAttemptId: body?.checkoutAttemptId, token: body?.emailVerificationToken });
  const subscriptionId = cleanString(body?.subscriptionId, 200);
  const reason = cleanString(body?.reason, 80);
  const reasonText = cleanString(body?.reasonText, 1000);
  if (!subscriptionId) throw new ValidationError({ subscriptionId: "Subscription is required." });
  if (!MANAGE_REASONS.has(reason)) throw new ValidationError({ reason: "Please choose a cancellation reason." });
  if (reason === "other" && reasonText.length < 3) throw new ValidationError({ reasonText: "Please add a short cancellation note." });
  const subscription = ObjectId.isValid(subscriptionId)
    ? await db.collection("careSubscriptions").findOne({ _id: new ObjectId(subscriptionId), customerEmail: verification.email })
    : await db.collection("careSubscriptions").findOne({ $or: [{ _id: subscriptionId }, { stripeSubscriptionId: subscriptionId }], customerEmail: verification.email });
  if (!subscription) throw Object.assign(new Error("Subscription not found."), { statusCode: 404 });
  if (subscription.cancelAtPeriodEnd) return { subscription: serializeCareSubscription(subscription), alreadyCancelled: true };

  const stripe = getStripe(env);
  const updatedStripeSubscription = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: true,
    metadata: {
      cancellation_reason: reason,
      cancellation_reason_text: reasonText,
    },
  });
  const now = new Date();
  const updated = {
    ...subscription,
    status: updatedStripeSubscription.status === "active" ? "active_until_period_end" : updatedStripeSubscription.status,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: dateFromStripeSeconds(updatedStripeSubscription.current_period_end) || subscription.currentPeriodEnd,
    paidThroughDate: dateFromStripeSeconds(updatedStripeSubscription.current_period_end) || subscription.paidThroughDate,
    nextRenewalDate: null,
    cancellation: {
      reason,
      reasonText,
      requestedAt: now,
      effectiveAt: dateFromStripeSeconds(updatedStripeSubscription.current_period_end) || subscription.currentPeriodEnd,
      source: "customer_verified_email",
    },
    updatedAt: now,
    activity: [
      ...(Array.isArray(subscription.activity) ? subscription.activity : []),
      {
        employeeId: "customer",
        displayName: "Verified Customer",
        action: "care_future_renewal_cancelled",
        message: `${subscription.planName} future renewal was cancelled by verified email owner.`,
        createdAt: now,
      },
    ],
  };
  await db.collection("careSubscriptions").updateOne({ _id: subscription._id }, { $set: updated });
  await sendTrackedCareEmails(env, db, updated, { action: "cancelled" });
  return { subscription: serializeCareSubscription(updated), alreadyCancelled: false };
}

export async function listAdminCareSubscriptions({ db, search = "" }) {
  const queryText = cleanString(search, 160);
  const query = queryText
    ? {
        $or: [
          { orderNumber: normalizeOrderNumber(queryText) },
          { customerEmail: { $regex: queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
          { customerName: { $regex: queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
          { planName: { $regex: queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
        ],
      }
    : {};
  const subscriptions = await db.collection("careSubscriptions").find(query).sort({ updatedAt: -1 }).limit(100).toArray();
  return subscriptions.map(serializeCareSubscription);
}
