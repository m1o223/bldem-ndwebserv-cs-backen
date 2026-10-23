import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Anonymous, short-lived capability; no accounts, database or file storage involved.
export function createAttachmentSessions(now = Date.now) {
  const key = randomBytes(32);
  let count = 0, expires = now() + 60000;
  let analyses = 0, analysisWindow = now() + 60000, daily = 0, day = now() + 86400000;
  const sign = value => createHmac("sha256", key).update(value).digest("base64url");
  return {
    allowAnalysis() {
      if (now() >= analysisWindow) { analyses = 0; analysisWindow = now() + 60000; }
      if (now() >= day) { daily = 0; day = now() + 86400000; }
      if (analyses >= 4 || daily >= 40) return false;
      analyses++; daily++; return true;
    },
    issue() {
      if (now() >= expires) { count = 0; expires = now() + 60000; }
      if (++count > 60) return null;
      const value = `${randomBytes(18).toString("base64url")}.${now() + 20 * 60000}`;
      return `${value}.${sign(value)}`;
    },
    verify(token) {
      if (typeof token !== "string" || token.length > 150) return false;
      const parts = token.split(".");
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]{24}$/.test(parts[0]) || !/^\d{13}$/.test(parts[1])) return false;
      const until = Number(parts[1]);
      if (until <= now() || until > now() + 20 * 60000) return false;
      const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
      const supplied = Buffer.from(parts[2]);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  };
}
