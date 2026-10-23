import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import mammoth from "mammoth";
import readExcelFile from "read-excel-file/node";
import yauzl from "yauzl";
import { XMLValidator } from "fast-xml-parser";

const fail = (code = "attachment_invalid") => { throw Object.assign(new Error("Rejected"), { code }); };
const utf8 = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
let pdfPages = 0;
function safeText(text) {
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail();
  if (text.length > 40000) fail("attachment_limit");
  return text;
}

// Validate actual decompressed sizes before the document reader sees the ZIP.
function inspectZip(bytes, kind) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, total = 0, ended = false;
      const names = new Set();
      const stop = error => { if (!ended) { ended = true; zip.close(); reject(error); } };
      zip.on("error", stop);
      zip.on("end", () => {
        if (ended) return;
        ended = true;
        if (!names.has("[Content_Types].xml") || !names.has(kind === "docx" ? "word/document.xml" : "xl/workbook.xml")) return reject(new Error("Wrong package"));
        resolve();
      });
      zip.on("entry", entry => {
        const name = entry.fileName;
        if (++count > 300 || names.has(name) || name.split("/").includes("..") || name.startsWith("/") || /[\\:\x00]/.test(name)
          || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)
          || /(?:vbaProject|embeddings\/|activeX\/|externalLinks\/|\.bin$)/i.test(name)
          || entry.uncompressedSize > 4 * 1024 * 1024 || (total + entry.uncompressedSize) > 8 * 1024 * 1024) return stop(new Error("Unsafe package"));
        names.add(name);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return stop(error);
          let size = 0;
          const chunks = [];
          const xml = /\.(xml|rels)$/.test(name);
          stream.on("error", stop);
          stream.on("data", chunk => {
            size += chunk.length; total += chunk.length;
            if (size > entry.uncompressedSize || total > 8 * 1024 * 1024) { stream.destroy(); stop(new Error("Expansion limit")); }
            else if (xml) chunks.push(chunk);
          });
          stream.on("end", () => {
            if (ended) return;
            try {
              if (xml) {
                const text = utf8(Buffer.concat(chunks));
                if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error("Unsafe XML");
              }
              zip.readEntry();
            } catch (error) { stop(error); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function parse(file) {
  const bytes = Buffer.from(file.data, "base64");
  const ext = file.name.split(".").at(-1).toLowerCase();
  if (file.type.startsWith("image/")) {
    const signature = file.type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : file.type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!signature) fail();
    const image = sharp(bytes, { limitInputPixels: 16000000, failOn: "warning", animated: false });
    const metadata = await image.metadata();
    if ({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[metadata.format] !== file.type || metadata.pages > 1) fail();
    const clean = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    return [{ type: "input_text", text: `Attached image: ${file.name}` }, { type: "input_image", image_url: `data:image/webp;base64,${clean.toString("base64")}`, detail: "auto" }];
  }
  if (ext === "pdf") {
    if (bytes.subarray(0, 5).toString() !== "%PDF-") fail();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (pdf.isEncrypted) fail();
    pdfPages += pdf.getPageCount();
    if (!pdf.getPageCount() || pdfPages > 10) fail("attachment_limit");
    const pending = pdf.context.enumerateIndirectObjects().map(([, object]) => object);
    const visited = new Set();
    while (pending.length) {
      const object = pending.pop();
      if (visited.has(object)) continue;
      visited.add(object);
      if (visited.size > 50000) fail("attachment_limit");
      if (object instanceof PDFDict) {
        if (["JS", "JavaScript", "AA", "OpenAction", "EmbeddedFiles", "EF", "XFA", "Launch"].some(key => object.has(PDFName.of(key)))) fail();
        pending.push(...object.values());
      } else if (object instanceof PDFArray) pending.push(...object.asArray());
      else if (object?.dict instanceof PDFDict) pending.push(object.dict);
    }
    return [{ type: "input_file", filename: file.name, file_data: `data:application/pdf;base64,${file.data}` }];
  }
  let text, scope;
  if (ext === "txt") { text = safeText(utf8(bytes)); scope = "Complete UTF-8 text"; }
  else {
    if (bytes.readUInt32LE(0) !== 0x04034b50) fail();
    await inspectZip(bytes, ext);
    if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer: bytes }, { externalFileAccess: false });
      text = safeText(result.value);
      scope = "Extracted main document text; headers, footers, comments, embedded images, charts and exact formatting are NOT included";
    } else if (ext === "xlsx") {
      const sheets = await readExcelFile(bytes);
      if (sheets.length > 10) fail("attachment_limit");
      let cells = 0;
      text = sheets.map(({ sheet, data }) => {
        if (data.length > 500 || data.some(row => row.length > 50)) fail("attachment_limit");
        cells += data.reduce((sum, row) => sum + row.filter(value => value != null).length, 0);
        if (cells > 2000) fail("attachment_limit");
        return `Sheet: ${sheet}\n` + data.map((row, i) => `Row ${i + 1}: ${JSON.stringify(row)}`).join("\n");
      }).join("\n\n");
      text = safeText(text);
      scope = "Sheet cell values only; formulas are NOT recalculated; embedded images, charts and layout are NOT included";
    } else fail();
  }
  return [{ type: "input_text", text: JSON.stringify({ untrusted_attachment: file.name, analysis_scope: scope, content: text }) }];
}

try {
  let extracted = 0;
  const messages = [];
  for (const message of workerData) {
    if (!message.attachments?.length) { messages.push(message); continue; }
    const content = [{ type: "input_text", text: message.content || "Please analyze the attached files." }];
    for (const file of message.attachments) {
      const parts = await parse(file);
      extracted += parts.reduce((sum, part) => sum + (part.text?.length || 0), 0);
      if (extracted > 60000) fail("attachment_limit");
      content.push(...parts);
    }
    messages.push({ role: message.role, content });
  }
  parentPort.postMessage({ messages });
} catch (error) {
  parentPort.postMessage({ error: error.code === "attachment_limit" ? "attachment_limit" : "attachment_invalid" });
}
