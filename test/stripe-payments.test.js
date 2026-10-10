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
  getStripe,
  getStripeRuntimeConfig,
  getStripePriceId,
  resolveCheckoutPaymentMethod,
} from "../src/stripePayments.js";

const expected = [
  ["showcase-website", 499000, 249500, 124750],
  ["business-website", 899000, 449500, 224750],
  ["online-store", 1499000, 749500, 374750],
];

test("public website packages use server-calculated Stripe Checkout amounts", () => {
  for (const [packageId] of expected) {
    assert.throws(() => getStripePriceId(packageId, "full"), /server-calculated Stripe Checkout amount/);
    assert.throws(() => getStripePriceId(packageId, "deposit_50"), /server-calculated Stripe Checkout amount/);
    assert.throws(() => getStripePriceId(packageId, "deposit_25"), /server-calculated Stripe Checkout amount/);
  }
});

test("Stripe mapping contains the BlueMind test package product and one-time price", () => {
  assert.match(STRIPE_PRODUCT_IDS["bluemind-test-package"], /^prod_/);
  assert.match(getStripePriceId("bluemind-test-package", "full"), /^price_/);
  assert.throws(() => getStripePriceId("bluemind-test-package", "deposit"), /server-calculated Stripe Checkout amount/);
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
    assert.equal(full.stripePriceId, null);
    assert.equal(deposit.stripePriceId, null);
    assert.equal(quarter.stripePriceId, null);
    assert.equal(buildStripeLineItem(full).price_data.unit_amount, totalAmountOre);
    assert.equal(buildStripeLineItem(deposit).price_data.unit_amount, depositOre);
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
    packageId: "showcase-website",
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
  assert.equal(params.line_items[0].price_data.unit_amount, 124750);
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

  const liveSecret = "whsec_live_secret";
  const liveHeader = Stripe.webhooks.generateTestHeaderString({ payload, secret: liveSecret });
  const liveEvent = constructStripeEvent({
    STRIPE_ENVIRONMENT: "live",
    ENABLE_STRIPE_LIVE_PAYMENTS: "true",
    STRIPE_LIVE_SECRET_KEY: "rk_live_fake",
    STRIPE_LIVE_WEBHOOK_SECRET: liveSecret,
  }, Buffer.from(payload), liveHeader);
  assert.equal(liveEvent.id, "evt_test");
  assert.throws(() => constructStripeEvent({
    STRIPE_ENVIRONMENT: "live",
    ENABLE_STRIPE_LIVE_PAYMENTS: "true",
    STRIPE_LIVE_SECRET_KEY: "rk_live_fake",
    STRIPE_WEBHOOK_SECRET: secret,
  }, Buffer.from(payload), liveHeader), /live webhook secret/);
});

test("Stripe runtime config separates test and live activation", () => {
  assert.deepEqual(getStripeRuntimeConfig({ STRIPE_SECRET_KEY: "sk_test_fake" }), {
    key: "sk_test_fake",
    mode: "test",
    livemode: false,
  });
  assert.throws(() => getStripeRuntimeConfig({ STRIPE_SECRET_KEY: "rk_live_fake" }), /Live Stripe keys are not allowed/);
  assert.throws(() => getStripeRuntimeConfig({
    STRIPE_ENVIRONMENT: "live",
    STRIPE_LIVE_SECRET_KEY: "rk_live_fake",
  }), /disabled/);
  assert.deepEqual(getStripeRuntimeConfig({
    STRIPE_ENVIRONMENT: "live",
    ENABLE_STRIPE_LIVE_PAYMENTS: "true",
    STRIPE_LIVE_SECRET_KEY: "rk_live_fake",
  }), {
    key: "rk_live_fake",
    mode: "live",
    livemode: true,
  });
  assert.throws(() => getStripe({
    STRIPE_ENVIRONMENT: "live",
    ENABLE_STRIPE_LIVE_PAYMENTS: "true",
    STRIPE_LIVE_SECRET_KEY: "sk_test_fake",
  }), /requires a live/);
});
