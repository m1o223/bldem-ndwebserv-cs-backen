import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { image, pdf, docx, xlsx, file } from "../test/fixtures/attachments.mjs";

const directory = path.resolve(process.argv[2] || "test-output/attachments");
await mkdir(directory, { recursive: true });
const fixtures = [await image("png", 320, 480), await image("jpeg", 640, 320, "#0000ff"), await image("webp", 400, 400, "#00ff00"), await pdf(), await docx(), await xlsx(), file("notes.txt", "The launch code is LIME-482. The cafe opens at 09:30.")];
for (const fixture of fixtures) await writeFile(path.join(directory, fixture.name), Buffer.from(fixture.data, "base64"));
console.log(`Generated ${fixtures.length} synthetic test files.`);
