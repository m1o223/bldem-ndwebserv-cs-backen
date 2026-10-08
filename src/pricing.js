export const CURRENCY = "SEK";

export const PAYMENT_OPTIONS = {
  FULL: "full",
  DEPOSIT: "deposit",
};

export const WEBSITE_PACKAGE_CATALOG = [
  {
    packageId: "one-page-website",
    aliases: ["one-page"],
    name: "One Page Website",
    totalAmountOre: 449000,
    currency: CURRENCY,
    estimatedDelivery: "5-7 business days",
    active: true,
    features: [
      "One polished landing page",
      "Responsive desktop, tablet, and mobile design",
      "Contact section",
      "Core brand styling",
    ],
  },
  {
    packageId: "small-website",
    aliases: [],
    name: "Small Website",
    totalAmountOre: 599000,
    currency: CURRENCY,
    estimatedDelivery: "7-10 business days",
    active: true,
    features: [
      "Up to 3 pages",
      "Custom responsive design",
      "Contact form",
      "Basic content structure",
    ],
  },
  {
    packageId: "business-website",
    aliases: [],
    name: "Business Website",
    totalAmountOre: 749000,
    currency: CURRENCY,
    estimatedDelivery: "10-14 business days",
    active: true,
    features: [
      "Up to 5 pages",
      "Professional business layout",
      "Responsive desktop, tablet, and mobile design",
      "Contact form and service sections",
    ],
  },
  {
    packageId: "business-plus",
    aliases: [],
    name: "Business Plus",
    totalAmountOre: 999000,
    currency: CURRENCY,
    estimatedDelivery: "14-18 business days",
    active: true,
    features: [
      "Expanded business website",
      "Advanced page structure",
      "Responsive desktop, tablet, and mobile design",
      "Enhanced conversion sections",
    ],
  },
  {
    packageId: "online-store",
    aliases: [],
    name: "Online Store",
    totalAmountOre: 1299000,
    currency: CURRENCY,
    estimatedDelivery: "18-25 business days",
    active: true,
    features: [
      "Storefront design",
      "Product/category structure",
      "Responsive desktop, tablet, and mobile design",
      "Checkout-ready interface foundation",
    ],
  },
  {
    packageId: "custom-website",
    aliases: ["custom"],
    name: "Custom Website",
    totalAmountOre: null,
    currency: CURRENCY,
    estimatedDelivery: "Quoted after review",
    active: false,
    requestQuoteOnly: true,
    features: ["Custom scope", "Custom timeline", "Custom quote"],
  },
];

const PACKAGE_BY_ID = new Map();
for (const item of WEBSITE_PACKAGE_CATALOG) {
  PACKAGE_BY_ID.set(item.packageId, item);
  for (const alias of item.aliases || []) PACKAGE_BY_ID.set(alias, item);
}

export function listActiveWebsitePackages() {
  return WEBSITE_PACKAGE_CATALOG.filter(item => item.active).map(toPublicPackage);
}

export function getWebsitePackage(packageId) {
  if (typeof packageId !== "string") return null;
  return PACKAGE_BY_ID.get(packageId.trim()) || null;
}

export function toPublicPackage(item) {
  return {
    packageId: item.packageId,
    name: item.name,
    totalAmountOre: item.totalAmountOre,
    currency: item.currency,
    estimatedDelivery: item.estimatedDelivery,
    active: item.active,
    requestQuoteOnly: Boolean(item.requestQuoteOnly),
    features: [...item.features],
  };
}

export function validateFixedPricePackage(packageId) {
  const item = getWebsitePackage(packageId);
  if (!item || !item.active || !Number.isInteger(item.totalAmountOre)) {
    throw new Error("Invalid fixed-price package.");
  }
  return item;
}

export function normalizePaymentOption(value) {
  if (value === PAYMENT_OPTIONS.FULL || value === "pay_full") return PAYMENT_OPTIONS.FULL;
  if (value === PAYMENT_OPTIONS.DEPOSIT || value === "pay_deposit" || value === "half") return PAYMENT_OPTIONS.DEPOSIT;
  throw new Error("Invalid payment option.");
}

export function calculatePaymentAmounts(packageId, paymentOption) {
  const item = validateFixedPricePackage(packageId);
  const option = normalizePaymentOption(paymentOption);
  const totalAmountOre = item.totalAmountOre;
  const amountDueNowOre = option === PAYMENT_OPTIONS.FULL
    ? totalAmountOre
    : Math.floor(totalAmountOre / 2);
  const remainingBalanceOre = totalAmountOre - amountDueNowOre;

  return {
    packageId: item.packageId,
    packageName: item.name,
    paymentOption: option,
    currency: item.currency,
    totalAmountOre,
    amountDueNowOre,
    remainingBalanceOre,
  };
}

export function createPriceSnapshot(packageId, paymentOption) {
  const item = validateFixedPricePackage(packageId);
  const amounts = calculatePaymentAmounts(item.packageId, paymentOption);
  return {
    packageId: item.packageId,
    packageName: item.name,
    packagePriceOre: item.totalAmountOre,
    currency: item.currency,
    estimatedDelivery: item.estimatedDelivery,
    features: [...item.features],
    paymentOption: amounts.paymentOption,
    totalAmountOre: amounts.totalAmountOre,
    amountDueNowOre: amounts.amountDueNowOre,
    remainingBalanceOre: amounts.remainingBalanceOre,
    capturedAt: new Date(),
  };
}

export function formatSek(amountOre) {
  if (!Number.isInteger(amountOre)) return "";
  return `${new Intl.NumberFormat("sv-SE").format(amountOre / 100)} SEK`;
}
