export const AI_LIMITS = {
    messageChars: 4000,
    assistantChars: 12000,
    contextChars: 18000,
    turns: 20,
    bodyBytes: 80000,
    outputTokens: 2000
};
export const AI_ERRORS = {
    unavailable: "BlueMind AI is temporarily unavailable. Please try again later.",
    invalid: "Please shorten your message and try again.",
    rate: "Too many requests. Please wait a minute before trying again.",
    timeout: "The response took too long. Please try again.",
    failed: "We could not complete the response. Please try again.",
    stopped: "The response was stopped before it finished."
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
    if (!body || typeof body !== "object" || Object.keys(body).some((key)=>key !== "messages")) return null;
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > AI_LIMITS.turns) return null;
    let chars = 0;
    const result = [];
    for (const message of messages){
        if (!message || typeof message !== "object" || Object.keys(message).some((key)=>![
                "role",
                "content"
            ].includes(key))) return null;
        if (message.role !== "user" && message.role !== "assistant") return null;
        if (typeof message.content !== "string" || !message.content.trim()) return null;
        if (message.content.length > (message.role === "user" ? AI_LIMITS.messageChars : AI_LIMITS.assistantChars)) return null;
        chars += message.content.length;
        if (chars > AI_LIMITS.contextChars) return null;
        result.push({
            role: message.role,
            content: message.content.trim()
        });
    }
    return result[0].role === "user" && result.at(-1).role === "user" ? result : null;
}
