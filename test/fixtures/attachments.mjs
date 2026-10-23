import JSZip from "jszip";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { FILE_TYPES } from "../../src/ai/attachments.js";

export function file(name, bytes) { return { name, type: FILE_TYPES[name.split(".").at(-1)], data: Buffer.from(bytes).toString("base64") }; }
export async function image(format = "png", width = 320, height = 480, color = "#ff0000") {
  return file(`sample.${format === "jpeg" ? "jpg" : format}`, await sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer());
}
export async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) document.addPage([500, 300]).drawText("BlueMind fixture: Cedar Cafe opens at 09:30. Project code LIME-482.", { x: 20, y: 220, size: 11, font });
  return file("brief.pdf", await document.save());
}
export async function docx(extra = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Website brief: Cedar Cafe. Launch code LIME-482.</w:t></w:r></w:p><w:p><w:r><w:t>Include a menu and contact page.</w:t></w:r></w:p></w:body></w:document>');
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return file("brief.docx", await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
export async function xlsx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Count</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Landing pages</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>');
  return file("budget.xlsx", await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
