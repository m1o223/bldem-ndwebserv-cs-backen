import { Worker } from "node:worker_threads";

export const FILE_LIMITS = { count: 4, fileBytes: 2 * 1024 * 1024, totalBytes: 2560 * 1024, textChars: 40000 };
export const FILE_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function validateAttachments(files, budget) {
  if (!Array.isArray(files) || !files.length || files.length > FILE_LIMITS.count) return null;
  const result = [];
  for (const file of files) {
    if (!file || typeof file !== "object" || Object.keys(file).some(k => !["name", "type", "data"].includes(k))) return null;
    if (typeof file.name !== "string" || !file.name.trim() || file.name.length > 120 || /[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(file.name)) return null;
    const ext = file.name.split(".").at(-1)?.toLowerCase();
    if (!FILE_TYPES[ext] || file.type !== FILE_TYPES[ext] || typeof file.data !== "string") return null;
    if (!file.data.length || file.data.length % 4 || file.data.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) return null;
    const bytes = Buffer.from(file.data, "base64");
    if (!bytes.length || bytes.length > FILE_LIMITS.fileBytes || bytes.toString("base64") !== file.data) return null;
    budget.count++; budget.bytes += bytes.length;
    if (budget.count > FILE_LIMITS.count || budget.bytes > FILE_LIMITS.totalBytes) return null;
    result.push({ name: file.name, type: file.type, data: file.data });
  }
  return result;
}

let parsing = false;
export function prepareAttachments(messages, signal, { timeoutMs = 10000 } = {}) {
  if (!messages.some(message => message.attachments?.length)) return Promise.resolve(messages);
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  if (parsing) return Promise.reject(Object.assign(new Error("busy"), { code: "rate_limit_exceeded" }));
  parsing = true;
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL("./attachment-worker.js", import.meta.url), {
      workerData: messages, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      stdout: true, stderr: true,
    }); } catch {
      parsing = false;
      reject(Object.assign(new Error("Attachment rejected"), { code: "attachment_invalid" }));
      return;
    }
    // Never forward parser output, filenames, document contents or worker errors to logs.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      void worker.terminate().finally(() => { parsing = false; error ? reject(error) : resolve(value); });
    };
    const failure = code => Object.assign(new Error("Attachment rejected"), { code });
    const abort = () => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(failure("attachment_limit")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", result => result.error ? finish(failure(result.error)) : finish(null, result.messages));
    worker.once("error", () => finish(failure("attachment_invalid")));
    worker.once("exit", () => { if (!settled) finish(failure("attachment_invalid")); });
    if (signal.aborted) abort();
  });
}
