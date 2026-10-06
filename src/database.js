import { MongoClient } from "mongodb";

let clientPromise;
let activeUri;

export function getMongoUri(env = process.env) {
  const uri = env.MONGODB_URI;
  if (!uri || typeof uri !== "string" || !uri.trim()) {
    throw new Error("MONGODB_URI must be configured");
  }
  return uri.trim();
}

export function getDatabaseName(env = process.env) {
  return (env.MONGODB_DB || "bluemind_web_service").trim() || "bluemind_web_service";
}

export async function getDatabase(env = process.env) {
  const uri = getMongoUri(env);
  if (!clientPromise || activeUri !== uri) {
    activeUri = uri;
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    clientPromise = client.connect().catch(error => {
      clientPromise = undefined;
      activeUri = undefined;
      throw error;
    });
  }
  const client = await clientPromise;
  return client.db(getDatabaseName(env));
}

export async function closeDatabaseConnection() {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = undefined;
  activeUri = undefined;
  await client.close();
}
