import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  STRIPE_PRICE_IDS,
  buildCheckoutDraft,
  constructStripeEvent,
  getStripePriceId,
} from "../src/stripePayments.js";

const expected = [
  ["one-page-website", 449000, 224500],
  ["small-website", 599000, 299500],
  ["business-website", 749000, 374500],
  ["business-plus", 999000, 499500],
  ["online-store", 1299000, 649500],
];

test("Stripe price mapping contains full and deposit prices for every fixed website package", () => {
  for (const [packageId] of expected) {
    assert.match(getStripePriceId(packageId, "full"), /^price_/);
    assert.match(getStripePriceId(packageId, "deposit"), /^price_/);
    assert.notEqual(STRIPE_PRICE_IDS[packageId].full, STRIPE_PRICE_IDS[packageId].deposit);
  }
});

test("checkout draft validates package, payment option, email, project description, and amounts", () => {
  for (const [packageId, totalAmountOre, depositOre] of expected) {
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
