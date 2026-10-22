// Policy text verified against the Web Service quote cards and Care FAQ at 142bd8b.
// Prices/features are read live from the existing backend catalogs, not duplicated here.
export const websitePolicy = {
  currencyUnits: "Catalog amounts ending in Ore are in ore: divide by 100 for SEK.",
  vatNote: "Prices exclude VAT where VAT applies. Final VAT treatment appears on the invoice.",
  sharedFeatures: [
    "Launch Assistance: We help you publish your website and make it available online.",
    "Revisions Included: You can request changes before delivery within the agreed project scope.",
  ],
  businessSystem: "Choose ONE: online booking OR pickup orders. Online payment and delivery are not included.",
  extraCosts: "Domains, hosting, payment providers and external services may cost extra.",
};

export const carePolicy = {
  exclusions: "Hosting, domain registration, and paid third-party services are not included unless explicitly stated in your agreement.",
  cancellation: "Cancellation stops future renewals. Monthly service remains active to the end of the paid billing period. Annual service is paid upfront and remains active for the paid annual period. Cancellation does not automatically provide a refund for unused time; applicable statutory rights remain unaffected.",
  smallChanges: "Updates to existing text, contact information, images, buttons, links, minor content and small layout adjustments within the existing design. Care Plus includes up to 30 minutes/month; Care Pro up to 60 minutes/month. Unused time does not carry over. New pages, features, major redesigns and custom development are quoted separately.",
  planChanges: "Contact BlueMind to request a change; options, pricing and effective timing are explained before confirmation.",
  failedPayment: "BlueMind may contact the customer to update their payment method or settle payment. Unresolved services may be paused or discontinued under subscription terms. Additional charges require authorization.",
  support: "Use the official contact page with your name, website address and a short description. Response follows the support level in your plan.",
};
