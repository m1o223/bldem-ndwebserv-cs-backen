export const CURRENCY = "SEK";

export const PAYMENT_OPTIONS = {
  FULL: "full",
  DEPOSIT_50: "deposit_50",
  DEPOSIT_25: "deposit_25",
};

export const WEBSITE_PACKAGE_CATALOG = [
  {
    packageId: "showcase-website",
    aliases: [],
    name: "Showcase Website",
    totalAmountOre: 499000,
    currency: CURRENCY,
    estimatedDelivery: "Delivery depends on the agreed content and project scope.",
    active: true,
    features: [
      "Up to 3 pages of your choice",
      "Custom design with your preferred colors and style",
      "Show work, products, or services",
      "Contact form or WhatsApp contact option",
      "Responsive mobile, tablet, and desktop layout",
      "Google-friendly setup",
      "Domain connection help",
      "Design changes before delivery within the agreed plan",
    ],
  },
  {
    packageId: "business-website",
    aliases: [],
    name: "Business Website",
    totalAmountOre: 899000,
    currency: CURRENCY,
    estimatedDelivery: "Delivery depends on whether your project uses booking or pickup orders and the agreed scope.",
    active: true,
    features: [
      "Everything in Showcase Website",
      "Up to 6 pages of your choice",
      "Online booking or pickup order system",
      "Private page to manage bookings or pickup orders",
      "Email notifications for bookings or orders",
      "Service, price, and availability updates",
      "Organized customer request records",
      "Online payment and delivery are not included",
    ],
  },
  {
    packageId: "online-store",
    aliases: [],
    name: "Online Store",
    totalAmountOre: 1499000,
    currency: CURRENCY,
    estimatedDelivery: "Estimated delivery depends on the agreed features and project scope.",
    active: true,
    features: [
      "Up to 10 custom pages plus product pages",
      "Custom online shop design",
      "Product photos, descriptions, and prices",
      "Shopping cart",
      "Secure online payments through supported methods",
      "Shipping options at checkout",
      "Private store management page",
      "Stock tracking",
      "Search and categories",
      "Discount codes",
      "Automatic order confirmation emails",
      "Advanced shipping integrations, additional languages, and special features may cost extra",
    ],
  },
  {
    packageId: "bluemind-test-package",
    aliases: ["test-package", "sandbox-test"],
    name: "BlueMind Test Package",
    totalAmountOre: 1000,
    currency: CURRENCY,
    estimatedDelivery: "Sandbox test only",
    active: true,
    testOnly: true,
    features: [
      "Secure checkout test",
      "Payment confirmation",
      "Order tracking",
      "Email notifications",
      "Admin Dashboard integration",
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

export function listActiveWebsitePackages({ includeTestPackages = false } = {}) {
  return WEBSITE_PACKAGE_CATALOG
    .filter(item => item.active && (includeTestPackages || !item.testOnly))
    .map(toPublicPackage);
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
    testOnly: Boolean(item.testOnly),
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
  if (value === PAYMENT_OPTIONS.DEPOSIT_50 || value === "deposit" || value === "pay_deposit" || value === "half") return PAYMENT_OPTIONS.DEPOSIT_50;
  if (value === PAYMENT_OPTIONS.DEPOSIT_25 || value === "quarter" || value === "pay_quarter") return PAYMENT_OPTIONS.DEPOSIT_25;
  throw new Error("Invalid payment option.");
}

function calculateDepositAmountOre(totalAmountOre, numerator, denominator) {
  // Round down in ore for the amount due now, then assign every remaining ore
  // to the final balance so paid + remaining always equals the package total.
  return Math.floor((totalAmountOre * numerator) / denominator);
}

export function calculatePaymentAmounts(packageId, paymentOption) {
  const item = validateFixedPricePackage(packageId);
  const option = normalizePaymentOption(paymentOption);
  if (item.testOnly && option !== PAYMENT_OPTIONS.FULL) {
    throw new Error("Test package only supports full payment.");
  }

  const totalAmountOre = item.totalAmountOre;
  const amountDueNowOre = option === PAYMENT_OPTIONS.FULL
    ? totalAmountOre
    : option === PAYMENT_OPTIONS.DEPOSIT_25
      ? calculateDepositAmountOre(totalAmountOre, 1, 4)
      : calculateDepositAmountOre(totalAmountOre, 1, 2);
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
  const hasOre = amountOre % 100 !== 0;
  return `${new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: hasOre ? 2 : 0,
    maximumFractionDigits: hasOre ? 2 : 0,
  }).format(amountOre / 100)} SEK`;
}
