import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  STRIPE_PRICE_IDS,
  STRIPE_PRODUCT_IDS,
  buildStripeLineItem,
  buildCheckoutDraft,
  constructStripeEvent,
  getStripePriceId,
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
