import { validateAttachments } from "./attachments.js";
export const AI_LIMITS = {
    messageChars: 4000,
    assistantChars: 12000,
    contextChars: 18000,
    turns: 20,
    bodyBytes: 3700000,
    textBodyBytes: 80000,
    outputTokens: 2000
};
export const AI_ERRORS = {
    unavailable: "BlueMind AI is temporarily unavailable. Please try again later.",
    invalid: "Please shorten your message and try again.",
    rate: "Too many requests. Please wait a minute before trying again.",
    timeout: "The response took too long. Please try again.",
    failed: "We could not complete the response. Please try again.",
    stopped: "The response was stopped before it finished.",
    attachment_invalid: "This file could not be processed. Use a valid JPEG, PNG, WebP, PDF, DOCX, UTF-8 TXT or XLSX file without encryption or active content.",
    attachment_limit: "This document exceeds analysis limits. Use up to 10 PDF pages, 40,000 text characters, or 2,000 spreadsheet cells (500 rows per sheet). No content was silently omitted.",
    attachment_session: "Your upload session expired. Please try again."
};
export function boundedContext(turns) {
    const result = [];
    let size = 0;
    for (const turn of turns.slice(-AI_LIMITS.turns).reverse()){
        if (size + turn.content.length > AI_LIMITS.contextChars) break;
        result.unshift(turn);
        size += turn.content.length;
    }
    while(result[0]?.role === "assistant")result.shift();
    return result;
}
export function validateTurns(body) {
    if (!body || typeof body !== "object" || Object.keys(body).some((key)=>!["messages", "responseFormat"].includes(key))) return null;
    if (Object.hasOwn(body, "responseFormat") && body.responseFormat !== "message-card-v1") return null;
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > AI_LIMITS.turns) return null;
    let chars = 0;
    const budget = { count: 0, bytes: 0 };
    const result = [];
    for (const message of messages){
        if (!message || typeof message !== "object" || Object.keys(message).some((key)=>![
                "role",
                "content", "attachments"
            ].includes(key))) return null;
        if (message.role !== "user" && message.role !== "assistant") return null;
        if (typeof message.content !== "string" || (!message.content.trim() && !message.attachments?.length)) return null;
        const attachments = message.attachments === undefined ? undefined : validateAttachments(message.attachments, budget);
        if (message.attachments !== undefined && (!attachments || message.role !== "user")) return null;
        if (message.content.length > (message.role === "user" ? AI_LIMITS.messageChars : AI_LIMITS.assistantChars)) return null;
        chars += message.content.length;
        if (chars > AI_LIMITS.contextChars) return null;
        result.push({
            role: message.role,
            content: message.content.trim(),
            ...(attachments ? { attachments } : {})
        });
    }
    return result[0].role === "user" && result.at(-1).role === "user" ? result : null;
}
