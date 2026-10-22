export function allowedAiOrigins(env) {
  const value = env.AI_ALLOWED_ORIGINS?.trim();
  if (!value || value.length > 4000) return null;
  const origins = value.split(",").map(origin => origin.trim());
  if (origins.length > 20) return null;
  try {
    for (const origin of origins) {
      const url = new URL(origin);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local && url.protocol === "http:"))) return null;
    }
    return new Set(origins);
  } catch { return null; }
}
