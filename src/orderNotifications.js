import { createHash, randomUUID } from "node:crypto";
import {
  sendBusinessNewOrderNotification,
  sendCustomerClarificationRequest,
  sendCustomerPaymentConfirmation,
  sendCustomerReviewConfirmation,
} from "./email.js";
import { createOrderActivity, normalizeOrderNumber } from "./orders.js";

export const ORDER_NOTIFICATION_TYPES = {
  BUSINESS_NEW_ORDER: "business_new_order",
  CUSTOMER_PAYMENT_CONFIRMATION: "customer_payment_confirmation",
  CUSTOMER_REVIEW_CONFIRMATION: "customer_review_confirmation",
  CLARIFICATION_REQUEST: "clarification_request",
};

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeError(error) {
  return cleanString(error?.message || "Notification send failed.", 400);
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function typeLabel(type) {
  return type.replace(/_/g, " ");
}

async function pushOrderNotificationActivity(db, orderNumber, activity, summary) {
  const set = {
    [`notificationStatus.${summary.type}`]: summary,
    updatedAt: new Date(),
  };
  await db.collection("orders").updateOne(
    { orderNumber: normalizeOrderNumber(orderNumber) },
    {
      $set: set,
      $push: { activity },
    },
  );
}

export async function sendTrackedOrderNotification({ env, db, order, type, dedupeKey = "default", send }) {
  const orderNumber = normalizeOrderNumber(order?.orderNumber);
  if (!orderNumber) throw new Error("Order number is required for notifications.");
  const now = new Date();
  const collection = db.collection("orderNotifications");
  const filter = { orderNumber, type, dedupeKey };
  let notification = await collection.findOne(filter);

  if (notification?.status === "sent" || notification?.status === "delivered") {
    return { sent: false, skipped: true, reason: "already_sent", providerMessageId: notification.providerMessageId };
  }

  if (!notification) {
    const doc = {
      ...filter,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await collection.insertOne(doc);
      notification = doc;
      await pushOrderNotificationActivity(
        db,
        orderNumber,
        createOrderActivity({
          action: "notification_queued",
          message: `System queued ${typeLabel(type)} notification for ${orderNumber}.`,
          createdAt: now,
        }),
        { type, status: "queued", updatedAt: now },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      notification = await collection.findOne(filter);
      if (notification?.status === "sent" || notification?.status === "delivered") {
        return { sent: false, skipped: true, reason: "already_sent", providerMessageId: notification.providerMessageId };
      }
    }
  }

  const attempts = Number(notification?.attempts || 0) + 1;
  await collection.updateOne(filter, { $set: { status: "pending", attempts, updatedAt: new Date() } });

  try {
    const result = await send();
    if (!result?.sent) {
      const failedAt = new Date();
      const reason = cleanString(result?.reason || "not_sent", 120);
      await collection.updateOne(filter, {
        $set: { status: "failed", reason, attempts, updatedAt: failedAt },
      });
      await pushOrderNotificationActivity(
        db,
        orderNumber,
        createOrderActivity({
          action: "notification_failed",
          message: `System could not send ${typeLabel(type)} notification for ${orderNumber}.`,
          createdAt: failedAt,
        }),
        { type, status: "failed", reason, attempts, updatedAt: failedAt },
      );
      return { sent: false, reason };
    }

    const sentAt = new Date();
    const providerMessageId = cleanString(result.providerMessageId, 180) || undefined;
    await collection.updateOne(filter, {
      $set: { status: "sent", providerMessageId, attempts, sentAt, updatedAt: sentAt },
      $unset: { error: "", reason: "" },
    });
    await pushOrderNotificationActivity(
      db,
      orderNumber,
      createOrderActivity({
        action: "notification_sent",
        message: `System sent ${typeLabel(type)} notification for ${orderNumber}.`,
        createdAt: sentAt,
      }),
      { type, status: "sent", providerMessageId, attempts, sentAt, updatedAt: sentAt },
    );
    return { sent: true, providerMessageId };
  } catch (error) {
    const failedAt = new Date();
    const message = safeError(error);
    await collection.updateOne(filter, {
      $set: { status: "failed", error: message, attempts, updatedAt: failedAt },
    });
    await pushOrderNotificationActivity(
      db,
      orderNumber,
      createOrderActivity({
        action: "notification_failed",
        message: `System could not send ${typeLabel(type)} notification for ${orderNumber}.`,
        createdAt: failedAt,
      }),
      { type, status: "failed", error: message, attempts, updatedAt: failedAt },
    );
    console.error("Order notification failed", { orderNumber, type, message });
    return { sent: false, reason: "failed" };
  }
}

export async function sendInitialOrderNotifications(env, db, order) {
  const business = await sendTrackedOrderNotification({
    env,
    db,
    order,
    type: ORDER_NOTIFICATION_TYPES.BUSINESS_NEW_ORDER,
    dedupeKey: order.paymentEventId || "default",
    send: () => sendBusinessNewOrderNotification(env, order),
  });
  const customer = await sendTrackedOrderNotification({
    env,
    db,
    order,
    type: ORDER_NOTIFICATION_TYPES.CUSTOMER_PAYMENT_CONFIRMATION,
    dedupeKey: order.paymentEventId || "default",
    send: () => sendCustomerPaymentConfirmation(env, order),
  });
  return { business, customer };
}

export async function sendOrderReviewConfirmationNotification(env, db, order) {
  return await sendTrackedOrderNotification({
    env,
    db,
    order,
    type: ORDER_NOTIFICATION_TYPES.CUSTOMER_REVIEW_CONFIRMATION,
    dedupeKey: "review-confirmed",
    send: () => sendCustomerReviewConfirmation(env, order),
  });
}

export async function sendClarificationRequestNotification(env, db, order, { message, employee, requestId }) {
  const key = requestId || hashText(`${order.orderNumber}:${employee?.employeeId}:${message}`);
  return await sendTrackedOrderNotification({
    env,
    db,
    order,
    type: ORDER_NOTIFICATION_TYPES.CLARIFICATION_REQUEST,
    dedupeKey: key,
    send: () => sendCustomerClarificationRequest(env, order, { message, employee }),
  });
}

export function createClarificationRequest({ message, employee }) {
  const createdAt = new Date();
  return {
    requestId: randomUUID(),
    message: cleanString(message, 2400),
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    status: "sent",
    createdAt,
  };
}
