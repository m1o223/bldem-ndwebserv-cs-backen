import bcrypt from "bcryptjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const password = (await readStdin()) || process.env.PASSWORD || "";
if (!password || password.length < 10) {
  console.error("Provide a temporary password of at least 10 characters through stdin or PASSWORD.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
