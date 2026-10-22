import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AI_LIMITS, validateTurns } from "./contract.js";
import { openAIProvider } from "./provider.js";
import { allowedAiOrigins } from "./config.js";
export function configurationIssue(env = process.env) {
    if (env.AI_ENABLED !== "true") return "feature_disabled";
    if (!env.OPENAI_API_KEY?.trim()) return "missing_api_key";
    if (!allowedAiOrigins(env)) return "invalid_ai_origins";
    return null;
}
export function aiAvailable(env = process.env) {
    return configurationIssue(env) === null;
}
export function createLimiter(now = Date.now) {
    const clients = new Map();
    let active = 0;
    let minute = { count: 0, expires: now() + 60000 };
    let daily = {
        count: 0,
        expires: now() + 86400000
    };
    return (id)=>{
        const time = now();
        if (minute.expires <= time) minute = { count: 0, expires: time + 60000 };
        for (const [key, value] of clients)if (value.expires <= time && !value.active) clients.delete(key);
        if (daily.expires <= time) daily = {
            count: 0,
            expires: time + 86400000
        };
        const value = clients.get(id) ?? {
            count: 0,
            expires: time + 60000,
            active: 0
        };
        if (value.expires <= time) {
            value.count = 0;
            value.expires = time + 60000;
        }
        if (active >= 4 || value.active >= 1 || value.count >= 10 || minute.count >= 20 || daily.count >= 200 || !clients.has(id) && clients.size >= 1000) return null;
        minute.count++;
        value.count++;
        value.active++;
        active++;
        daily.count++;
        clients.set(id, value);
        let released = false;
        return ()=>{
            if (!released) {
                released = true;
                value.active--;
                active--;
            }
        };
    };
}
const salt = randomBytes(32);
const jsonError = (code, status)=>Response.json({
        code
    }, {
        status,
        headers: {
            "Cache-Control": "no-store",
            ...status === 429 ? {
                "Retry-After": "60"
            } : {}
        }
    });
async function readBody(request) {
    if (Number(request.headers.get("content-length")) > AI_LIMITS.bodyBytes) throw new Error("size");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("body");
    let bytes = 0;
    const chunks = [];
    let expired = false;
    const timeout = setTimeout(()=>{
        expired = true;
        void reader.cancel().catch(()=>{});
    }, 5000);
    try {
        while(true){
            const chunk = await reader.read();
            if (expired) throw new Error("timeout");
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > AI_LIMITS.bodyBytes) {
                await reader.cancel();
                throw new Error("size");
            }
            chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally{
        clearTimeout(timeout);
        reader.releaseLock();
    }
}
export function classifyFailure(error, aborted) {
    const detail = typeof error === "object" && error !== null ? error : {};
    const providerStatus = typeof detail.status === "number" && Number.isInteger(detail.status) && detail.status >= 400 && detail.status <= 599 ? detail.status : undefined;
    let code = "failed";
    let diagnostic = "provider_failure";
    if (aborted || detail.name === "APIConnectionTimeoutError") {
        code = "timeout";
        diagnostic = "timeout";
    } else if (detail.code === "insufficient_quota" || detail.code === "billing_hard_limit_reached") {
        code = "unavailable";
        diagnostic = "provider_quota";
    } else if (providerStatus === 401 || detail.code === "invalid_api_key") {
        code = "unavailable";
        diagnostic = "provider_authentication";
    } else if (providerStatus === 403) {
        code = "unavailable";
        diagnostic = "provider_permission";
    } else if (providerStatus === 404 || detail.code === "model_not_found") {
        code = "unavailable";
        diagnostic = "provider_model_unavailable";
    } else if (providerStatus === 429 || detail.code === "rate_limit_exceeded") {
        code = "rate";
        diagnostic = "provider_rate_limit";
    } else if (providerStatus === 400 || providerStatus === 422) diagnostic = "provider_request_invalid";
    else if (detail.name === "APIConnectionError") diagnostic = "provider_connection";
    else if (detail.code === "incomplete_response") diagnostic = "provider_incomplete";
    return {
        code,
        diagnostic,
        ...providerStatus ? {
            providerStatus
        } : {}
    };
}
export function createChatHandler(options = {}) {
    let reportedConfiguration = null;
    const acquire = options.limiter ?? createLimiter();
    return async (request, peerAddress = "unknown")=>{
        const env = options.env ?? process.env;
        const log = options.log ?? ((entry)=>console.info(JSON.stringify(entry)));
        const issue = configurationIssue(env);
        if (issue) {
            if (reportedConfiguration !== issue) log({
                event: "bluemind_ai",
                requestId: randomUUID(),
                outcome: "unavailable",
                diagnostic: issue,
                durationMs: 0,
                inputTokens: 0,
                outputTokens: 0
            });
            reportedConfiguration = issue;
            return jsonError("unavailable", 503);
        }
        reportedConfiguration = null;
        if (!allowedAiOrigins(env)?.has(request.headers.get("origin"))) return jsonError("invalid", 403);
        if (request.method !== "POST") return jsonError("invalid", 405);
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return jsonError("invalid", 415);
        // Do not trust client-supplied forwarding headers. Proxy peers can share a quota.
        const clientId = createHash("sha256").update(salt).update(peerAddress.slice(0, 200)).digest("hex");
        const release = acquire(clientId);
        if (!release) return jsonError("rate", 429);
        let messages;
        try {
            messages = validateTurns(await readBody(request));
        } catch  {
            release();
            return jsonError("invalid", 400);
        }
        if (!messages) {
            release();
            return jsonError("invalid", 400);
        }
        const started = Date.now();
        const requestId = randomUUID();
        const controller = new AbortController();
        const abort = ()=>controller.abort();
        request.signal.addEventListener("abort", abort, {
            once: true
        });
        if (request.signal.aborted) abort();
        const timeout = setTimeout(abort, options.timeoutMs ?? 55000);
        let logged = false;
        const finish = (outcome, inputTokens = 0, outputTokens = 0, failure)=>{
            clearTimeout(timeout);
            request.signal.removeEventListener("abort", abort);
            release();
            if (!logged) {
                logged = true;
                log({
                    event: "bluemind_ai",
                    requestId,
                    outcome,
                    durationMs: Date.now() - started,
                    inputTokens,
                    outputTokens,
                    ...failure ? {
                        diagnostic: failure.diagnostic,
                        providerStatus: failure.providerStatus
                    } : {}
                });
            }
        };
        try {
            const provider = options.provider ?? openAIProvider(env.OPENAI_API_KEY.trim(), env.OPENAI_MODEL?.trim() || "gpt-5.4-mini");
            const events = await provider(messages, controller.signal);
            const encoder = new TextEncoder();
            let cancelled = false;
            const body = new ReadableStream({
                async start (stream) {
                    const emit = (event)=>{
                        if (!cancelled) stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                    };
                    let chars = 0;
                    let completed = false;
                    try {
                        for await (const event of events){
                            if (controller.signal.aborted) throw new Error("aborted");
                            if (event.type === "delta") {
                                chars += event.text.length;
                                if (chars > AI_LIMITS.assistantChars) throw new Error("output limit");
                                emit(event);
                            } else {
                                if (!chars) throw new Error("empty response");
                                completed = true;
                                emit({
                                    type: "done"
                                });
                                finish("completed", event.inputTokens, event.outputTokens);
                                break;
                            }
                        }
                        if (!completed) throw new Error("incomplete stream");
                    } catch (error) {
                        const failure = classifyFailure(error, controller.signal.aborted);
                        const { code } = failure;
                        emit({
                            type: "error",
                            code
                        });
                        finish(request.signal.aborted || cancelled ? "cancelled" : code, 0, 0, failure);
                    } finally{
                        abort();
                        if (!cancelled) stream.close();
                    }
                },
                cancel () {
                    cancelled = true;
                    abort();
                    finish("cancelled");
                }
            });
            return new Response(body, {
                headers: {
                    "Content-Type": "application/x-ndjson; charset=utf-8",
                    "Cache-Control": "no-store, no-transform",
                    "X-Content-Type-Options": "nosniff"
                }
            });
        } catch (error) {
            const failure = classifyFailure(error, controller.signal.aborted);
            const { code } = failure;
            finish(code, 0, 0, failure);
            return jsonError(code, code === "rate" ? 429 : code === "timeout" ? 504 : 502);
        }
    };
}
