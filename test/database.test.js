import test from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../src/database.js";

test("MongoDB connection cache resets after failed connect attempts", async () => {
  const env = {
    MONGODB_URI: "mongodb://127.0.0.1:1/bluemind_web_service",
    MONGODB_DB: "bluemind_web_service",
  };

  await assert.rejects(() => getDatabase(env));
  await assert.rejects(() => getDatabase(env));
});
