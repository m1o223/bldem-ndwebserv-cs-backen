import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePaymentAmounts,
  formatSek,
  getWebsitePackage,
  listActiveWebsitePackages,
} from "../src/pricing.js";
import {
  calculateCarePrice,
  getCareStripePriceId,
  listCarePlans,
} from "../src/carePricing.js";
import {
  buildCareSubscriptionDraft,
  buildOrderDocumentFromVerifiedPayment,
  createTestOrder,
  getNextOrderNumber,
  recordPaymentEventOnce,
} from "../src/orders.js";
import { ValidationError } from "../src/validation.js";

const expectedPrices = [
  ["showcase-website", "Showcase Website", 499000, 249500, 124750],
  ["business-website", "Business Website", 899000, 449500, 224750],
  ["online-store", "Online Store", 1499000, 749500, 374750],
];

test("website pricing catalog matches the agreed package prices", () => {
  const active = listActiveWebsitePackages();
  assert.equal(active.length, 3);

  for (const [packageId, name, totalAmountOre, depositOre, quarterDepositOre] of expectedPrices) {
    const item = getWebsitePackage(packageId);
    assert.equal(item.name, name);
    assert.equal(item.totalAmountOre, totalAmountOre);
    assert.equal(item.currency, "SEK");
    assert.equal(calculatePaymentAmounts(packageId, "deposit").paymentOption, "deposit_50");
    assert.equal(calculatePaymentAmounts(packageId, "deposit_50").amountDueNowOre, depositOre);
    assert.equal(calculatePaymentAmounts(packageId, "deposit_50").remainingBalanceOre, totalAmountOre - depositOre);
    assert.equal(calculatePaymentAmounts(packageId, "deposit_25").amountDueNowOre, quarterDepositOre);
    assert.equal(calculatePaymentAmounts(packageId, "deposit_25").remainingBalanceOre, totalAmountOre - quarterDepositOre);
    assert.equal(calculatePaymentAmounts(packageId, "full").amountDueNowOre, totalAmountOre);
    assert.equal(calculatePaymentAmounts(packageId, "full").remainingBalanceOre, 0);
  }
});

test("test package is available only through the full-payment sandbox path", () => {
  const publicActive = listActiveWebsitePackages();
  const withTest = listActiveWebsitePackages({ includeTestPackages: true });
  assert.equal(publicActive.some(item => item.packageId === "bluemind-test-package"), false);
  assert.equal(withTest.some(item => item.packageId === "bluemind-test-package"), true);
  assert.equal(calculatePaymentAmounts("bluemind-test-package", "full").amountDueNowOre, 1000);
  assert.equal(calculatePaymentAmounts("bluemind-test-package", "full").remainingBalanceOre, 0);
  assert.throws(() => calculatePaymentAmounts("bluemind-test-package", "deposit"), /Test package only supports full payment/);
  assert.throws(() => calculatePaymentAmounts("bluemind-test-package", "deposit_25"), /Test package only supports full payment/);
});

test("SEK formatting preserves öre for fractional deposit amounts", () => {
  assert.equal(formatSek(499000).replace(/\s/g, " "), "4 990 SEK");
  assert.equal(formatSek(124750).replace(/\s/g, " "), "1 247,50 SEK");
});

test("custom quote package and invalid package ids cannot produce payment amounts", () => {
  assert.throws(() => calculatePaymentAmounts("custom-website", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("one-page-website", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("small-website", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("business-plus", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("online-store-standard", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("online-store-advanced", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("missing-package", "full"), /Invalid fixed-price package/);
  assert.throws(() => calculatePaymentAmounts("business-website", "monthly"), /Invalid payment option/);
});

test("verified payment builds a paid order with a price snapshot and project details", () => {
  const order = buildOrderDocumentFromVerifiedPayment({
    packageId: "business-website",
    paymentOption: "deposit_25",
    customerName: "Demo Customer",
    verifiedEmail: "CUSTOMER@example.com",
    companyName: "Demo Company",
    projectDescription: "Build a polished business website.",
    requestedFeatures: ["Contact Form", "Gallery"],
    websiteDetails: {
      businessName: "Demo Company",
      websiteType: "Business website",
      additionalNotes: "Use a minimal style.",
    },
    paymentProvider: "stripe",
    stripeLivemode: true,
    selectedPaymentMethod: "visa",
    stripePaymentMethodType: "card",
    paymentMethodDisplayName: "Visa",
    paymentEventId: "evt_test_deposit",
    paymentReference: "pi_test",
  }, { orderNumber: "#516", paidAt: new Date("2026-10-08T10:00:00.000Z") });

  assert.equal(order.orderNumber, "#516");
  assert.equal(order.packageId, "business-website");
  assert.equal(order.totalAmountOre, 899000);
  assert.equal(order.amountPaidOre, 224750);
  assert.equal(order.remainingBalanceOre, 674250);
  assert.equal(order.paymentOption, "deposit_25");
  assert.equal(order.selectedPaymentMethod, "visa");
  assert.equal(order.stripePaymentMethodType, "card");
  assert.equal(order.paymentMethodDisplayName, "Visa");
  assert.equal(order.paymentStatus, "Deposit Paid");
  assert.equal(order.projectStatus, "Pending Review");
  assert.equal(order.reviewStatus, "pending_review");
  assert.equal(order.verifiedEmail, "customer@example.com");
  assert.equal(order.priceSnapshot.packagePriceOre, 899000);
  assert.deepEqual(order.requestedFeatures, ["Contact Form", "Gallery"]);
  assert.equal(order.events[0].type, "deposit_received");
  assert.equal(order.careEligibility.eligible, true);
  assert.equal(order.isPaidOrder, true);
  assert.equal(order.paymentMode, "live");
  assert.equal(order.stripeLivemode, true);
});

test("verified Stripe Sandbox test payment builds a separated test order", () => {
  const order = buildOrderDocumentFromVerifiedPayment({
    packageId: "bluemind-test-package",
    paymentOption: "full",
    customerName: "Test Customer",
    verifiedEmail: "test.customer@example.com",
    projectDescription: "Verify the complete BlueMind order pipeline.",
    requestedFeatures: ["Secure checkout test", "Email notifications"],
    paymentProvider: "stripe",
    stripeLivemode: false,
    paymentEventId: "evt_test_package",
    paymentReference: "pi_test_package",
  }, { orderNumber: "#600", paidAt: new Date("2026-10-08T11:00:00.000Z") });

  assert.equal(order.packageId, "bluemind-test-package");
  assert.equal(order.totalAmountOre, 1000);
  assert.equal(order.amountPaidOre, 1000);
  assert.equal(order.remainingBalanceOre, 0);
  assert.equal(order.paymentStatus, "Test Paid");
  assert.equal(order.projectStatus, "Pending Review");
  assert.equal(order.isSandboxTestOrder, true);
  assert.equal(order.isPaidOrder, false);
  assert.equal(order.paymentMode, "test");
  assert.equal(order.stripeLivemode, false);
  assert.equal(order.source, "stripe_sandbox_test");
  assert.equal(order.careEligibility.eligible, false);
  assert.match(order.internalNotes, /Sandbox test order/);
});

test("Stripe Sandbox payments for normal packages are not real paid orders", () => {
  const order = buildOrderDocumentFromVerifiedPayment({
    packageId: "business-website",
    paymentOption: "deposit_50",
    customerName: "Sandbox Customer",
    verifiedEmail: "sandbox.customer@example.com",
    projectDescription: "Verify that test-mode payments stay separated.",
    paymentProvider: "stripe",
    stripeLivemode: false,
    paymentEventId: "cs_test_normal_package",
    paymentReference: "pi_test_normal_package",
  }, { orderNumber: "#601", paidAt: new Date("2026-10-08T12:00:00.000Z") });

  assert.equal(order.packageId, "business-website");
  assert.equal(order.paymentStatus, "Test Deposit Paid");
  assert.equal(order.isPaidOrder, false);
  assert.equal(order.isSandboxTestOrder, true);
  assert.equal(order.paymentMode, "test");
  assert.equal(order.source, "stripe_sandbox_test");
  assert.equal(order.careEligibility.eligible, false);
  assert.match(order.activity[0].message, /not a real paid customer order/);
});

test("verified payment order creation rejects missing critical fields", () => {
  assert.throws(() => buildOrderDocumentFromVerifiedPayment({
    packageId: "business-website",
    paymentOption: "full",
    customerName: "Demo Customer",
    verifiedEmail: "not-an-email",
    projectDescription: "Build a website.",
    paymentProvider: "stripe",
    paymentEventId: "evt_test",
  }, { orderNumber: "#517" }), ValidationError);
});

test("demo order remains clearly separated from real paid orders", () => {
  const order = createTestOrder();
  assert.equal(order.orderNumber, "#515");
  assert.equal(order.isDemo, true);
  assert.equal(order.isPaidOrder, false);
  assert.equal(order.paymentProvider, "demo");
  assert.equal(order.careEligibility.eligible, false);
});

test("BlueMind Care subscription draft requires order ownership inputs", () => {
  const draft = buildCareSubscriptionDraft({
    planId: "care-plus",
    billingInterval: "monthly",
    orderNumber: "512",
    customerEmail: "customer@example.com",
  });
  assert.equal(draft.orderNumber, "#512");
  assert.equal(draft.customerEmail, "customer@example.com");
  assert.equal(draft.ownershipVerified, false);

  assert.throws(() => buildCareSubscriptionDraft({
    planId: "care-plus",
    billingInterval: "weekly",
    orderNumber: "512",
    customerEmail: "customer@example.com",
  }), ValidationError);
});

test("BlueMind Care pricing uses monthly billing and upfront annual billing", () => {
  const plans = listCarePlans();
  assert.equal(plans.length, 3);

  const expected = [
    ["care-basic", 25000, 250000],
    ["care-plus", 50000, 500000],
    ["care-pro", 80000, 800000],
  ];
  for (const [planId, monthlyOre, yearlyOre] of expected) {
    const monthly = calculateCarePrice(planId, "monthly");
    const yearly = calculateCarePrice(planId, "yearly");
    assert.equal(monthly.amountOre, monthlyOre);
    assert.equal(monthly.coverageMonths, 1);
    assert.equal(yearly.amountOre, yearlyOre);
    assert.equal(yearly.regularAnnualAmountOre, monthlyOre * 12);
    assert.equal(yearly.annualSavingsOre, monthlyOre * 2);
    assert.equal(yearly.coverageMonths, 12);
    assert.match(getCareStripePriceId(planId, "monthly"), /^price_/);
    assert.match(getCareStripePriceId(planId, "yearly"), /^price_/);
  }
});

test("BlueMind Care sandbox test prices are separate from real plan prices", () => {
  const monthly = calculateCarePrice("care-plus", "monthly", { testMode: true });
  const yearly = calculateCarePrice("care-plus", "yearly", { testMode: true });
  assert.equal(monthly.amountOre, 500);
  assert.equal(yearly.amountOre, 500);
  assert.equal(monthly.planId, "care-plus");
  assert.equal(yearly.testMode, true);
  assert.match(getCareStripePriceId("care-plus", "monthly", { testMode: true }), /^price_/);
});

class FakeCounterCollection {
  constructor() {
    this.docs = new Map();
  }

  async updateOne(filter, update, options = {}) {
    let doc = this.docs.get(filter._id);
    if (!doc && options.upsert) {
      doc = { _id: filter._id, ...(update.$setOnInsert || {}) };
      this.docs.set(filter._id, doc);
    }
    if (doc && update.$set) Object.assign(doc, update.$set);
    return { acknowledged: true };
  }

  async findOneAndUpdate(filter, update) {
    const doc = this.docs.get(filter._id);
    if (!doc) return null;
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + amount;
    if (update.$set) Object.assign(doc, update.$set);
    return { ...doc };
  }
}

class FakePaymentEventsCollection {
  constructor() {
    this.keys = new Set();
  }

  async insertOne(doc) {
    const key = `${doc.provider}:${doc.eventId}`;
    if (this.keys.has(key)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.keys.add(key);
    return { acknowledged: true };
  }
}

test("order number generation starts after demo order #515 and increments safely", async () => {
  const counters = new FakeCounterCollection();
  const db = { collection: () => counters };
  assert.equal(await getNextOrderNumber(db), "#516");
  assert.equal(await getNextOrderNumber(db), "#517");
});

test("payment event recording is idempotent for duplicate provider events", async () => {
  const paymentEvents = new FakePaymentEventsCollection();
  const db = { collection: () => paymentEvents };
  const event = { provider: "stripe", eventId: "evt_123", type: "checkout.session.completed" };

  assert.equal(await recordPaymentEventOnce(db, event), true);
  assert.equal(await recordPaymentEventOnce(db, event), false);
});
