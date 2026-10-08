import { ValidationError } from "./validation.js";

export const CARE_PLAN_IDS = ["care-basic", "care-plus", "care-pro"];
export const CARE_BILLING_INTERVALS = ["monthly", "yearly"];

export const CARE_PLANS = [
  {
    planId: "care-basic",
    name: "Care Basic",
    monthlyAmountOre: 25000,
    yearlyAmountOre: 250000,
    currency: "SEK",
    features: ["Website monitoring", "Backups", "Technical checks", "Standard support"],
  },
  {
    planId: "care-plus",
    name: "Care Plus",
    monthlyAmountOre: 50000,
    yearlyAmountOre: 500000,
    currency: "SEK",
    features: ["Everything in Care Basic", "Up to 30 minutes of small website changes per month", "Priority support", "Performance check"],
  },
  {
    planId: "care-pro",
    name: "Care Pro",
    monthlyAmountOre: 80000,
    yearlyAmountOre: 800000,
    currency: "SEK",
    features: ["Everything in Care Plus", "Up to 60 minutes of small website changes per month", "Priority support", "Performance checks", "Monthly website check", "Monthly care summary"],
  },
];

export const CARE_TEST_PRICE = {
  planId: "care-test",
  name: "BlueMind Care Test Subscription",
  monthlyAmountOre: 500,
  yearlyAmountOre: 500,
  currency: "SEK",
};

export const STRIPE_CARE_PRICE_IDS = {
  "care-basic": {
    monthly: "price_1UOFA7IO0JggS4KFot72QR53",
    yearly: "price_1UOFAEIO0JggS4KFZCb5y8fj",
  },
  "care-plus": {
    monthly: "price_1UOFALIO0JggS4KFzaRgMyFA",
    yearly: "price_1UOFATIO0JggS4KFe2DkNY5m",
  },
  "care-pro": {
    monthly: "price_1UOFAZIO0JggS4KF4ErXJT1A",
    yearly: "price_1UOFAhIO0JggS4KFsJh05pTZ",
  },
  "care-test": {
    monthly: "price_1UOFAqIO0JggS4KFoP4tnAOU",
    yearly: "price_1UOFAwIO0JggS4KF3ClqsVZC",
  },
};

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeCareBillingInterval(value) {
  const normalized = cleanString(value, 20).toLowerCase();
  if (!CARE_BILLING_INTERVALS.includes(normalized)) throw new ValidationError({ billingInterval: "Invalid billing interval." });
  return normalized;
}

export function getCarePlan(planId) {
  const cleanPlanId = cleanString(planId, 80);
  const plan = CARE_PLANS.find(item => item.planId === cleanPlanId);
  if (!plan) throw new ValidationError({ planId: "Invalid BlueMind Care plan." });
  return plan;
}

export function calculateCarePrice(planId, billingInterval, { testMode = false } = {}) {
  const interval = normalizeCareBillingInterval(billingInterval);
  const plan = testMode ? CARE_TEST_PRICE : getCarePlan(planId);
  const amountOre = interval === "yearly" ? plan.yearlyAmountOre : plan.monthlyAmountOre;
  const realPlan = testMode ? getCarePlan(planId) : plan;
  return {
    planId: realPlan.planId,
    planName: realPlan.name,
    billingInterval: interval,
    amountOre,
    displayAmountOre: amountOre,
    currency: plan.currency,
    coverageMonths: interval === "yearly" ? 12 : 1,
    annualSavingsOre: interval === "yearly" && !testMode ? realPlan.monthlyAmountOre * 12 - realPlan.yearlyAmountOre : 0,
    regularAnnualAmountOre: interval === "yearly" && !testMode ? realPlan.monthlyAmountOre * 12 : undefined,
    testMode: Boolean(testMode),
  };
}

export function getCareStripePriceId(planId, billingInterval, { testMode = false } = {}) {
  const interval = normalizeCareBillingInterval(billingInterval);
  const key = testMode ? "care-test" : getCarePlan(planId).planId;
  const priceId = STRIPE_CARE_PRICE_IDS[key]?.[interval];
  if (!priceId) throw Object.assign(new Error("BlueMind Care plan is not configured for Stripe Checkout."), { statusCode: 400 });
  return priceId;
}

export function formatSekFromOre(value) {
  if (!Number.isInteger(value)) return "Not provided";
  return `${new Intl.NumberFormat("sv-SE").format(value / 100)} SEK`;
}

export function listCarePlans() {
  return CARE_PLANS.map(plan => ({
    ...plan,
    yearlyRule: "Pay 10 months upfront and receive 12 months of service.",
    annualSavingsOre: plan.monthlyAmountOre * 12 - plan.yearlyAmountOre,
  }));
}
