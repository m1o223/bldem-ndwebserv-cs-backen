import { pathToFileURL } from "node:url";
import { closeDatabaseConnection, getDatabase } from "./database.js";
import { createTestOrder, ensureOrderIndexes } from "./orders.js";

export async function seedTestOrder(env = process.env) {
  const db = await getDatabase(env);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name));
  if (!existing.has("orders")) await db.createCollection("orders");
  if (!existing.has("adminEvents")) await db.createCollection("adminEvents");
  await ensureOrderIndexes(db);

  const order = createTestOrder();
  await db.collection("orders").updateOne(
    { orderNumber: order.orderNumber },
    { $setOnInsert: order },
    { upsert: true },
  );

  return order.orderNumber;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const orderNumber = await seedTestOrder();
    console.log(`Seeded safe test order ${orderNumber}`);
  } finally {
    await closeDatabaseConnection();
  }
}
