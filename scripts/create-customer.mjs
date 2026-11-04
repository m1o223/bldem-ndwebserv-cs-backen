import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDatabase, closeDatabaseConnection } from "../src/database.js";
import { ensureCustomerIndexes } from "../src/customerAuth.js";

// Run only from an authorized terminal with the existing MongoDB configuration.
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const terminal = createInterface({ input: process.stdin, output, terminal: true });
try {
  if (!process.stdin.isTTY) throw new Error("Use an interactive terminal.");
  const email = (await terminal.question("Customer email: ")).trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email.");
  const displayName = (await terminal.question("Display name (optional): ")).trim().slice(0, 80) || email;
  process.stdout.write("Password (hidden, at least 15 characters): ");
  muted = true;
  const password = await terminal.question("");
  muted = false; process.stdout.write("\nConfirm password (hidden): "); muted = true;
  const confirm = await terminal.question("");
  muted = false; process.stdout.write("\n");
  if (password !== confirm || password.length < 15 || Buffer.byteLength(password) > 72) throw new Error("Passwords must match and contain 15+ characters, at most 72 UTF-8 bytes.");
  const db = await getDatabase();
  await ensureCustomerIndexes(db);
  if (await db.collection("customerAccounts").findOne({ email })) throw new Error("Account already exists. No changes made.");
  await db.collection("customerAccounts").insertOne({ _id: randomUUID(), email, displayName, passwordHash: await bcrypt.hash(password, 12), enabled: true, createdAt: new Date() });
  process.stdout.write("Customer account created. No workspace or order records were changed.\n");
} catch { process.stderr.write("Account creation failed. Check the input, existing account, and secure database configuration.\n"); process.exitCode = 1; }
finally { muted = false; terminal.close(); await closeDatabaseConnection(); }
