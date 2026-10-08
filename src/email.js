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

export function buildCustomerPaymentEmail(order) {
  return {
    subject: `BlueMind Web Service payment confirmed - ${order.orderNumber}`,
    text: [
      `Hello ${order.customerName || "there"},`,
      "",
      "Your BlueMind Web Service payment has been confirmed.",
      line("Order number", order.orderNumber),
      line("Package", order.packageName || order.package),
      line("Amount paid", formatSekFromOre(order.amountPaidOre)),
      line("Remaining balance", formatSekFromOre(order.remainingBalanceOre)),
      line("Payment status", order.paymentStatus),
      line("Project summary", order.projectDescription),
      "",
      "Our team will review your project details and contact you shortly.",
    ].join("\n"),
  };
}

export function buildBusinessPaymentEmail(order) {
  return {
    subject: `New BlueMind paid order - ${order.orderNumber}`,
    text: [
      "A new paid website order has been confirmed.",
      "",
      line("Order number", order.orderNumber),
      line("Customer", order.customerName),
      line("Email", order.email),
      line("Company", order.companyName),
      line("Package", order.packageName || order.package),
      line("Payment option", order.paymentOption),
      line("Amount paid", formatSekFromOre(order.amountPaidOre)),
      line("Remaining balance", formatSekFromOre(order.remainingBalanceOre)),
      line("Payment status", order.paymentStatus),
      line("Stripe payment reference", order.paymentReference),
      line("Project description", order.projectDescription),
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

export async function sendOrderPaymentNotifications(env, order) {
  const config = getEmailConfig(env);
  if (!config) {
    console.warn("Order payment emails skipped: Resend is not configured");
    return { customer: { sent: false, reason: "not_configured" }, business: { sent: false, reason: "not_configured" } };
  }

  const resend = getResendClient(config.apiKey);
  const customerEmail = buildCustomerPaymentEmail(order);
  const businessEmail = buildBusinessPaymentEmail(order);
  const result = { customer: { sent: false }, business: { sent: false } };

  const customer = await resend.emails.send({
    from: config.from,
    to: order.email,
    replyTo: config.to,
    subject: customerEmail.subject,
    text: customerEmail.text,
  });
  if (customer.error) throw new Error(customer.error.message || "Customer order email failed");
  result.customer = { sent: true };

  const business = await resend.emails.send({
    from: config.from,
    to: config.to,
    replyTo: order.email,
    subject: businessEmail.subject,
    text: businessEmail.text,
  });
  if (business.error) throw new Error(business.error.message || "Business order email failed");
  result.business = { sent: true };

  console.log("Order payment emails sent", { provider: "resend", orderNumber: order.orderNumber });
  return result;
}
export async function sendEmailVerificationCode(env, { email, code, language = "en" }) {
  const config = getEmailConfig(env);
  if (!config) {
    console.warn("Email verification skipped: Resend is not configured");
    throw new Error("Resend is not configured");
  }

  const emailContent = buildEmailVerificationEmail({ code, language });
  const result = await getResendClient(config.apiKey).emails.send({
    from: config.from,
    to: email,
    replyTo: config.to,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
  });

  if (result.error) throw new Error(result.error.message || "Verification email failed");
  console.log("Email verification sent", { provider: "resend", id: result.data?.id ? "present" : "missing" });
  return { sent: true };
}
