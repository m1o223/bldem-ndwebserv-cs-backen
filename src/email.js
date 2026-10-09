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

function getCustomerEmailConfig(env) {
  const config = getEmailConfig(env);
  if (!config) return null;

  return {
    ...config,
    from: env.EMAIL_VERIFICATION_FROM || env.CUSTOMER_EMAIL_FROM || config.from,
    replyTo: env.EMAIL_VERIFICATION_REPLY_TO || env.CUSTOMER_EMAIL_REPLY_TO || config.to,
  };
}

function getResendClient(apiKey) {
  if (!resendClient || activeApiKey !== apiKey) {
    resendClient = new Resend(apiKey);
    activeApiKey = apiKey;
  }
  return resendClient;
}


const verificationCopy = {
  en: {
    subject: "BlueMind - Verify Your Email",
    greeting: "Hello,",
    intro: "Your BlueMind verification code is:",
    instruction: "Enter this code on our website to verify your email address.",
    expiry: "This code expires in 10 minutes.",
    ignore: "If you didn't request this code, you can ignore this email.",
  },
  sv: {
    subject: "BlueMind - Verifiera din e-post",
    greeting: "Hej,",
    intro: "Din verifieringskod från BlueMind är:",
    instruction: "Ange koden på vår webbplats för att verifiera din e-postadress.",
    expiry: "Koden gäller i 10 minuter.",
    ignore: "Om du inte begärde den här koden kan du ignorera mejlet.",
  },
  ar: {
    subject: "BlueMind - تحقق من بريدك الإلكتروني",
    greeting: "مرحباً،",
    intro: "رمز التحقق الخاص بك من BlueMind هو:",
    instruction: "أدخل هذا الرمز على موقعنا لتأكيد بريدك الإلكتروني.",
    expiry: "تنتهي صلاحية هذا الرمز خلال 10 دقائق.",
    ignore: "إذا لم تطلب هذا الرمز، يمكنك تجاهل هذه الرسالة.",
  },
};

function getVerificationCopy(language) {
  return verificationCopy[language] || verificationCopy.en;
}

export function buildEmailVerificationEmail({ code, language = "en" }) {
  const copy = getVerificationCopy(language);
  return {
    subject: copy.subject,
    text: [
      copy.greeting,
      "",
      copy.intro,
      "",
      code,
      "",
      copy.instruction,
      copy.expiry,
      "",
      copy.ignore,
      "",
      "BlueMind Web Service",
    ].join("\n"),
    html: [
      '<div style="font-family:Arial,sans-serif;color:#171c25;line-height:1.6;max-width:560px">',
      `<p>${copy.greeting}</p>`,
      `<p>${copy.intro}</p>`,
      `<div style="font-size:32px;letter-spacing:8px;font-weight:700;border:1px solid #dfe4eb;border-radius:14px;padding:18px 22px;text-align:center;margin:20px 0;background:#f8fafc">${code}</div>`,
      `<p>${copy.instruction}</p>`,
      `<p>${copy.expiry}</p>`,
      `<p style="color:#667085;font-size:13px">${copy.ignore}</p>`,
      '<p>BlueMind Web Service</p>',
      '</div>',
    ].join(""),
  };
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

export function buildOrderReadyEmail(order) {
  return {
    subject: `Your BlueMind Web Service order ${order.orderNumber} is ready`,
    text: [
      `Hello ${order.customerName || "there"},`,
      "",
      `Your BlueMind Web Service order ${order.orderNumber} is ready.`,
      `Project: ${order.projectType || "Not provided"}`,
      `Service: ${order.service || "Not provided"}`,
      "",
      "This notification was generated from the BlueMind admin order system.",
    ].join("\n"),
  };
}

function formatSekFromOre(value) {
  if (!Number.isInteger(value)) return "Not provided";
  return `${new Intl.NumberFormat("sv-SE").format(value / 100)} SEK`;
}

function getAdminDashboardUrl(env, orderNumber) {
  const base = (env.ADMIN_FRONTEND_URL || "https://admin-bluemindwebservice.vercel.app").replace(/\/$/, "");
  return `${base}/?order=${encodeURIComponent(orderNumber)}`;
}

async function sendEmail(env, options, { customerFacing = false } = {}) {
  const config = customerFacing ? getCustomerEmailConfig(env) : getEmailConfig(env);
  if (!config) return { sent: false, reason: "not_configured" };

  const result = await getResendClient(config.apiKey).emails.send({
    from: options.from || config.from,
    to: options.to,
    replyTo: options.replyTo || config.replyTo || config.to,
    subject: options.subject,
    text: options.text,
    html: options.html,
  });
  if (result.error) throw new Error(result.error.message || "Resend email send failed");
  return { sent: true, providerMessageId: result.data?.id };
}

function paymentTypeLabel(order) {
  if (order.paymentOption === "deposit_25") return "25% Deposit";
  if (order.paymentOption === "deposit_50" || order.paymentOption === "deposit") return "50% Deposit";
  return "Full";
}

function isSandboxTestOrder(order) {
  return Boolean(order?.isSandboxTestOrder) || order?.packageId === "bluemind-test-package" || order?.testMode === "stripe_sandbox";
}

export function buildCustomerPaymentEmail(order) {
  if (isSandboxTestOrder(order)) {
    return {
      subject: "BlueMind - Test Payment Confirmed",
      text: [
        `Hello ${order.customerName || "there"},`,
        "",
        "Your BlueMind Sandbox test payment was confirmed.",
        "",
        line("Order Number", order.orderNumber),
        line("Package", order.packageName || order.package || "BlueMind Test Package"),
        line("Amount paid", formatSekFromOre(order.amountPaidOre)),
        "Payment Status: Paid",
        "Test Mode: Sandbox Test Only - No real payment was charged.",
        "",
        "BlueMind Web Service",
      ].join("\n"),
    };
  }

  return {
    subject: `BlueMind - Payment Received | Order ${order.orderNumber}`,
    text: [
      `Hello ${order.customerName || "there"},`,
      "",
      "Thank you for choosing BlueMind Web Service.",
      "We have successfully received your payment.",
      "",
      "Your order number is:",
      order.orderNumber,
      "",
      line("Package", order.packageName || order.package),
      line("Total Price", formatSekFromOre(order.totalAmountOre)),
      line("Payment Option", paymentTypeLabel(order)),
      line("Paid", formatSekFromOre(order.amountPaidOre)),
      line("Remaining", formatSekFromOre(order.remainingBalanceOre)),
      "",
      "Your project has been received and our team will review your requirements within 24 hours.",
      "We will contact you with the next steps.",
      "",
      "Thank you,",
      "BlueMind Web Service",
    ].join("\n"),
  };
}

export function buildBusinessPaymentEmail(order, env = {}) {
  const adminUrl = getAdminDashboardUrl(env, order.orderNumber);
  if (isSandboxTestOrder(order)) {
    return {
      subject: "BlueMind - New Test Order Received",
      text: [
        "NEW SANDBOX TEST ORDER RECEIVED",
        "",
        line("Order Number", order.orderNumber),
        line("Customer", order.customerName),
        line("Customer Email", order.email),
        line("Package", order.packageName || order.package || "BlueMind Test Package"),
        line("Payment Amount", formatSekFromOre(order.amountPaidOre)),
        "Payment Status: Paid",
        "Project Status: Pending Review",
        "Test Mode: Sandbox Test Only - do not count as real customer revenue.",
        "",
        `View Order in Admin Dashboard: ${adminUrl}`,
      ].join("\n"),
    };
  }

  return {
    subject: `New Paid Website Order - BlueMind ${order.orderNumber}`,
    text: [
      "NEW WEBSITE ORDER RECEIVED",
      "",
      line("Order Number", order.orderNumber),
      line("Customer", order.customerName),
      line("Customer Email", order.email),
      line("Package", order.packageName || order.package),
      line("Total Price", formatSekFromOre(order.totalAmountOre)),
      line("Payment Type", paymentTypeLabel(order)),
      line("Amount Paid", formatSekFromOre(order.amountPaidOre)),
      line("Remaining Balance", formatSekFromOre(order.remainingBalanceOre)),
      "Payment Status: Confirmed",
      line("Project Status", order.projectStatus || "Pending Review"),
      line("Project Description", order.projectDescription),
      line("Requested Features", Array.isArray(order.requestedFeatures) ? order.requestedFeatures.join(", ") : ""),
      line("Order Date", formatDate(order.createdAt || order.orderDate)),
      "",
      `View Order in Admin Dashboard: ${adminUrl}`,
    ].join("\n"),
  };
}

export function buildCustomerReviewedEmail(order) {
  return {
    subject: `BlueMind - Your Project Is Confirmed | Order ${order.orderNumber}`,
    text: [
      `Hello ${order.customerName || "there"},`,
      "",
      "We have reviewed your website order and your project requirements.",
      `Your order ${order.orderNumber} has now been confirmed by our team.`,
      "",
      "We understand the information you provided and are preparing to begin work on your website.",
      "We will keep you updated throughout the development process.",
      "If we need any additional details, we will contact you directly.",
      "",
      "Thank you for trusting BlueMind Web Service.",
      "",
      "Best regards,",
      "BlueMind Web Service",
    ].join("\n"),
  };
}

export function buildClarificationRequestEmail(order, { message, employee }) {
  return {
    subject: `BlueMind - A Question About Your Project | Order ${order.orderNumber}`,
    text: [
      `Hello ${order.customerName || "there"},`,
      "",
      `We have a question about your BlueMind Web Service order ${order.orderNumber}.`,
      "",
      message,
      "",
      `Sent by: ${employee?.displayName || "BlueMind Team"}`,
      "",
      "Please reply to this email with the requested details.",
      "",
      "Best regards,",
      "BlueMind Web Service",
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

export async function sendOrderReadyNotification(env, order) {
  if (env.ENABLE_ADMIN_NOTIFICATION_EMAILS !== "true") {
    console.warn("Order ready email skipped: admin notifications are disabled");
    return { sent: false, reason: "disabled" };
  }

  const config = getEmailConfig(env);
  if (!config) {
    console.warn("Order ready email skipped: Resend is not configured");
    return { sent: false, reason: "not_configured" };
  }

  const email = buildOrderReadyEmail(order);
  const result = await getResendClient(config.apiKey).emails.send({
    from: config.from,
    to: order.email,
    replyTo: config.to,
    subject: email.subject,
    text: email.text,
  });

  if (result.error) throw new Error(result.error.message || "Resend email send failed");
  console.log("Order ready email sent", { provider: "resend", orderNumber: order.orderNumber, id: result.data?.id ? "present" : "missing" });
  return { sent: true };
}

export async function sendBusinessNewOrderNotification(env, order) {
  const config = getEmailConfig(env);
  if (!config) return { sent: false, reason: "not_configured" };
  const email = buildBusinessPaymentEmail(order, env);
  return await sendEmail(env, {
    to: config.to,
    replyTo: order.email,
    subject: email.subject,
    text: email.text,
  });
}

export async function sendCustomerPaymentConfirmation(env, order) {
  const email = buildCustomerPaymentEmail(order);
  return await sendEmail(env, {
    to: order.email,
    subject: email.subject,
    text: email.text,
  }, { customerFacing: true });
}

export async function sendCustomerReviewConfirmation(env, order) {
  const email = buildCustomerReviewedEmail(order);
  return await sendEmail(env, {
    to: order.email,
    subject: email.subject,
    text: email.text,
  }, { customerFacing: true });
}

export async function sendCustomerClarificationRequest(env, order, options) {
  const email = buildClarificationRequestEmail(order, options);
  return await sendEmail(env, {
    to: order.email,
    subject: email.subject,
    text: email.text,
  }, { customerFacing: true });
}

export async function sendOrderPaymentNotifications(env, order) {
  const customer = await sendCustomerPaymentConfirmation(env, order);
  const business = await sendBusinessNewOrderNotification(env, order);
  console.log("Order payment emails sent", { provider: "resend", orderNumber: order.orderNumber });
  return { customer, business };
}

function careBillingLabel(subscription) {
  return subscription.billingInterval === "yearly" ? "Yearly" : "Monthly";
}

export function buildCareSubscriptionCustomerEmail(subscription, { action = "activated" } = {}) {
  const paidThrough = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toISOString().slice(0, 10) : "Not available";
  if (action === "cancelled") {
    return {
      subject: `BlueMind Care - Future renewal cancelled | ${subscription.planName}`,
      text: [
        `Hello ${subscription.customerName || "there"},`,
        "",
        "Your BlueMind Care future renewal has been cancelled.",
        "",
        line("Plan", subscription.planName),
        line("Billing", careBillingLabel(subscription)),
        line("Connected order", subscription.orderNumber),
        line("Paid-through date", paidThrough),
        "",
        "Your service remains active until the end of the current paid period.",
        "No additional renewal payment will be taken for this subscription.",
        "",
        "BlueMind Web Service",
      ].join("\n"),
    };
  }

  return {
    subject: `BlueMind Care activated | ${subscription.planName}`,
    text: [
      `Hello ${subscription.customerName || "there"},`,
      "",
      "Your BlueMind Care subscription is active.",
      "",
      line("Plan", subscription.planName),
      line("Billing", careBillingLabel(subscription)),
      line("Price", formatSekFromOre(subscription.amountOre)),
      line("Connected order", subscription.orderNumber),
      line("Paid-through date", paidThrough),
      subscription.billingInterval === "yearly" ? "Annual billing: you paid the discounted annual amount upfront and receive 12 months of service." : "Monthly billing renews automatically each month until cancelled.",
      "",
      "BlueMind Web Service",
    ].join("\n"),
  };
}

export function buildCareSubscriptionBusinessEmail(subscription, env = {}, { action = "activated" } = {}) {
  const adminUrl = getAdminDashboardUrl(env, subscription.orderNumber);
  return {
    subject: action === "cancelled"
      ? `BlueMind Care renewal cancelled - ${subscription.orderNumber}`
      : `New BlueMind Care subscription - ${subscription.orderNumber}`,
    text: [
      action === "cancelled" ? "BLUEMIND CARE FUTURE RENEWAL CANCELLED" : "NEW BLUEMIND CARE SUBSCRIPTION",
      "",
      line("Customer", subscription.customerName),
      line("Customer Email", subscription.customerEmail),
      line("Connected Order", subscription.orderNumber),
      line("Plan", subscription.planName),
      line("Billing", careBillingLabel(subscription)),
      line("Price", formatSekFromOre(subscription.amountOre)),
      line("Status", subscription.status),
      line("Paid-through date", subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toISOString() : ""),
      line("Cancellation reason", subscription.cancellation?.reason),
      "",
      `View Order in Admin Dashboard: ${adminUrl}`,
    ].join("\n"),
  };
}

export async function sendCareSubscriptionCustomerEmail(env, subscription, options) {
  const email = buildCareSubscriptionCustomerEmail(subscription, options);
  return await sendEmail(env, {
    to: subscription.customerEmail,
    subject: email.subject,
    text: email.text,
  }, { customerFacing: true });
}

export async function sendCareSubscriptionBusinessEmail(env, subscription, options) {
  const config = getEmailConfig(env);
  if (!config) return { sent: false, reason: "not_configured" };
  const email = buildCareSubscriptionBusinessEmail(subscription, env, options);
  return await sendEmail(env, {
    to: config.to,
    replyTo: subscription.customerEmail,
    subject: email.subject,
    text: email.text,
  });
}

export async function sendCareSubscriptionEmails(env, subscription, options) {
  const customer = await sendCareSubscriptionCustomerEmail(env, subscription, options);
  const business = await sendCareSubscriptionBusinessEmail(env, subscription, options);
  return { customer, business };
}
export async function sendEmailVerificationCode(env, { email, code, language = "en" }) {
  const config = getCustomerEmailConfig(env);
  if (!config) {
    console.warn("Email verification skipped: Resend is not configured");
    throw new Error("Resend is not configured");
  }

  const emailContent = buildEmailVerificationEmail({ code, language });
  const result = await getResendClient(config.apiKey).emails.send({
    from: config.from,
    to: email,
    replyTo: config.replyTo,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
  });

  if (result.error) {
    console.error("Verification email provider rejected send", { message: result.error.message || "unknown_error" });
    throw new Error(result.error.message || "Verification email failed");
  }
  console.log("Email verification sent", { provider: "resend", id: result.data?.id ? "present" : "missing" });
  return { sent: true };
}
