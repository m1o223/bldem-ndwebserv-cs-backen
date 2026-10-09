import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  STRIPE_PRICE_IDS,
  STRIPE_PRODUCT_IDS,
  buildStripeLineItem,
  buildCheckoutDraft,
  buildCheckoutSessionParams,
  constructStripeEvent,
  createStripeHostedCheckout,
  getStripePriceId,
  resolveCheckoutPaymentMethod,
} from "../src/stripePayments.js";

const expected = [
  ["one-page-website", 449000, 224500, 112250],
  ["small-website", 599000, 299500, 149750],
  ["business-website", 749000, 374500, 187250],
  ["business-plus", 999000, 499500, 249750],
  ["online-store", 1299000, 649500, 324750],
];

test("Stripe price mapping contains full and 50% deposit prices for every fixed website package", () => {
  for (const [packageId] of expected) {
    assert.match(getStripePriceId(packageId, "full"), /^price_/);
    assert.match(getStripePriceId(packageId, "deposit"), /^price_/);
    assert.match(getStripePriceId(packageId, "deposit_50"), /^price_/);
    assert.notEqual(STRIPE_PRICE_IDS[packageId].full, STRIPE_PRICE_IDS[packageId].deposit_50);
    assert.throws(() => getStripePriceId(packageId, "deposit_25"), /server-calculated Stripe Checkout amount/);
  }
});

test("Stripe mapping contains the BlueMind test package product and one-time price", () => {
  assert.match(STRIPE_PRODUCT_IDS["bluemind-test-package"], /^prod_/);
  assert.match(getStripePriceId("bluemind-test-package", "full"), /^price_/);
  assert.throws(() => getStripePriceId("bluemind-test-package", "deposit"), /Package is not configured for Stripe Checkout/);
  assert.throws(() => getStripePriceId("bluemind-test-package", "deposit_25"), /server-calculated Stripe Checkout amount/);

  const draft = buildCheckoutDraft({
    packageId: "bluemind-test-package",
    paymentOption: "full",
    customerName: "Test Customer",
    verifiedEmail: "customer@example.com",
    projectDescription: "Verify the test purchase flow.",
  });
  assert.equal(draft.amounts.totalAmountOre, 1000);
  assert.equal(draft.amounts.amountDueNowOre, 1000);
  assert.equal(draft.amounts.remainingBalanceOre, 0);
});

test("checkout draft validates package, payment option, email, project description, and amounts", () => {
  for (const [packageId, totalAmountOre, depositOre, quarterDepositOre] of expected) {
    const full = buildCheckoutDraft({
      packageId,
      paymentOption: "full",
      customerName: "Test Customer",
      verifiedEmail: "customer@example.com",
      projectDescription: "Build a website.",
    });
    assert.equal(full.amounts.totalAmountOre, totalAmountOre);
    assert.equal(full.amounts.amountDueNowOre, totalAmountOre);
    assert.equal(full.amounts.remainingBalanceOre, 0);

    const deposit = buildCheckoutDraft({
      packageId,
      paymentOption: "deposit",
      customerName: "Test Customer",
      verifiedEmail: "customer@example.com",
      projectDescription: "Build a website.",
    });
    assert.equal(deposit.amounts.amountDueNowOre, depositOre);
    assert.equal(deposit.amounts.remainingBalanceOre, totalAmountOre - depositOre);
    assert.equal(deposit.amounts.paymentOption, "deposit_50");

    const quarter = buildCheckoutDraft({
      packageId,
      paymentOption: "deposit_25",
      customerName: "Test Customer",
      verifiedEmail: "customer@example.com",
      projectDescription: "Build a website.",
    });
    assert.equal(quarter.amounts.amountDueNowOre, quarterDepositOre);
    assert.equal(quarter.amounts.remainingBalanceOre, totalAmountOre - quarterDepositOre);
    assert.equal(quarter.stripePriceId, null);
    const lineItem = buildStripeLineItem(quarter);
    assert.equal(lineItem.price_data.unit_amount, quarterDepositOre);
    assert.equal(lineItem.price_data.currency, "sek");
    assert.equal(lineItem.price_data.product_data.metadata.paymentOption, "deposit_25");
  }

  assert.throws(() => buildCheckoutDraft({
    packageId: "custom-website",
    paymentOption: "full",
    customerName: "Test Customer",
    verifiedEmail: "customer@example.com",
    projectDescription: "Build a website.",
  }));
  assert.throws(() => buildCheckoutDraft({
    packageId: "business-website",
    paymentOption: "weekly",
    customerName: "Test Customer",
    verifiedEmail: "customer@example.com",
    projectDescription: "Build a website.",
  }));
});

test("checkout payment method selection resolves to explicit Stripe Checkout methods", () => {
  assert.deepEqual(resolveCheckoutPaymentMethod("visa").stripePaymentMethodTypes, ["card"]);
  assert.equal(resolveCheckoutPaymentMethod("mastercard").providerType, "card");
  assert.equal(resolveCheckoutPaymentMethod("card").displayName, "Card");
  assert.throws(() => resolveCheckoutPaymentMethod("apple-pay"), /cannot be isolated/);
  assert.throws(() => resolveCheckoutPaymentMethod("google-pay"), /cannot be isolated/);
  assert.throws(() => resolveCheckoutPaymentMethod("paypal"), /not integrated/);
  assert.throws(() => resolveCheckoutPaymentMethod("klarna"), /not available/);
  assert.deepEqual(resolveCheckoutPaymentMethod("klarna", { ENABLE_STRIPE_KLARNA_CHECKOUT: "true" }).stripePaymentMethodTypes, ["klarna"]);
  assert.deepEqual(resolveCheckoutPaymentMethod("paypal", { ENABLE_STRIPE_PAYPAL_CHECKOUT: "true" }).stripePaymentMethodTypes, ["paypal"]);
});

test("checkout session params carry the selected method and exact server amount", () => {
  const draft = buildCheckoutDraft({
    packageId: "one-page-website",
    paymentOption: "deposit_25",
    customerName: "Test Customer",
    verifiedEmail: "customer@example.com",
    projectDescription: "Build a website.",
  });
  const params = buildCheckoutSessionParams({
    draft,
    frontendBase: "https://example.com",
    pendingCheckoutId: "pending_123",
    selectedPaymentMethod: resolveCheckoutPaymentMethod("visa"),
  });

  assert.deepEqual(params.payment_method_types, ["card"]);
  assert.equal(params.line_items[0].price_data.unit_amount, 112250);
  assert.equal(params.metadata.selectedPaymentMethod, "visa");
  assert.equal(params.metadata.stripePaymentMethodType, "card");
  assert.equal(params.payment_intent_data.metadata.selectedPaymentMethod, "visa");
});

test("Stripe hosted checkout retries with allowed payment method types when required", async () => {
  const calls = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          if (calls.length === 1) throw new Error("Received unknown parameter: payment_method_types");
          return { id: "cs_test_retry" };
        },
      },
    },
  };

  const session = await createStripeHostedCheckout(stripe, {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [],
  });

  assert.equal(session.id, "cs_test_retry");
  assert.deepEqual(calls[0].payment_method_types, ["card"]);
  assert.equal(calls[1].payment_method_types, undefined);
  assert.deepEqual(calls[1].allowed_payment_method_types, ["card"]);
});

test("Stripe webhook signatures are verified against the raw body", () => {
  const payload = JSON.stringify({
    id: "evt_test",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test", object: "checkout.session" } },
  });
  const secret = "whsec_test_secret";
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = constructStripeEvent({
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: secret,
  }, Buffer.from(payload), header);

  assert.equal(event.id, "evt_test");
  assert.throws(() => constructStripeEvent({
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_wrong",
  }, Buffer.from(payload), header));
});
