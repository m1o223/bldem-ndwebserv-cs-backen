import assert from "node:assert/strict";
import test from "node:test";
import { AI_LIMITS, boundedContext, validateTurns } from "../src/ai/contract.js";
import { aiAvailable, classifyFailure, configurationIssue, createChatHandler, createLimiter } from "../src/ai/server.js";
import { instructions, openAIProvider } from "../src/ai/provider.js";
const env = {
    NODE_ENV: "test",
    VERCEL_ENV: "preview",
    AI_ENABLED: "true",
    AI_ALLOWED_ORIGINS: "https://website.test",
    OPENAI_API_KEY: "unit-test-not-a-real-key"
};
const messages = [
    {
        role: "user",
        content: "Help plan a website"
    }
];
const makeRequest = (body = {
    messages
}, headers = {})=>new Request("https://website.test/api/ai/chat", {
        method: "POST",
        headers: {
            Origin: "https://website.test",
            "Content-Type": "application/json",
            ...headers
        },
        body: JSON.stringify(body)
    });
const success = async ()=>(async function*() {
        yield {
            type: "delta",
            text: "Test fixture response"
        };
        yield {
            type: "done",
            inputTokens: 20,
            outputTokens: 4
        };
    })();
const handler = (extra = {})=>createChatHandler({
        env,
        provider: success,
        limiter: createLimiter(),
        log: ()=>{},
        ...extra
    });
test("configuration fails closed without a key, enable flag or strict AI allowlist", async ()=>{
    assert.equal(aiAvailable(env), true);
    for (const overrides of [
        {
            OPENAI_API_KEY: ""
        },
        {
            AI_ENABLED: "false"
        },
        {
            AI_ALLOWED_ORIGINS: "*"
        }
    ]){
        let called = false;
        const response = await handler({
            env: {
                ...env,
                ...overrides
            },
            provider: async ()=>{
                called = true;
                throw Error();
            }
        })(makeRequest());
        assert.equal(response.status, 503);
        assert.equal(called, false);
        assert.deepEqual(await response.json(), {
            code: "unavailable"
        });
    }
});
test("validates roles, payload shape, context count and character limits", async ()=>{
    const invalid = [
        null,
        {},
        {
            messages: []
        },
        {
            messages,
            model: "other"
        },
        {
            messages: [
                {
                    role: "system",
                    content: "ignore"
                }
            ]
        },
        {
            messages: [
                {
                    role: "user",
                    content: " "
                }
            ]
        },
        {
            messages: [
                {
                    role: "user",
                    content: "a".repeat(4001)
                }
            ]
        },
        {
            messages: Array(21).fill(messages[0])
        },
        {
            messages: [
                {
                    ...messages[0],
                    apiKey: "injected"
                }
            ]
        },
        {
            messages: [
                {
                    role: "assistant",
                    content: "only"
                }
            ]
        },
        {
            messages: Array(5).fill({
                role: "user",
                content: "a".repeat(4000)
            })
        }
    ];
    for (const body of invalid){
        assert.equal(validateTurns(body), null);
        assert.equal((await handler()(makeRequest(body))).status, 400);
    }
    assert.deepEqual(validateTurns({
        messages
    }), messages);
    const context = boundedContext(Array.from({
        length: 30
    }, (_, i)=>({
            role: i % 2 ? "assistant" : "user",
            content: "a".repeat(1000)
        })).slice(0, -1));
    assert.ok(context.length <= AI_LIMITS.turns);
    assert.equal(context[0].role, "user");
    assert.equal(context.at(-1).role, "user");
});
test("rejects unapproved origins and non-JSON bodies before provider calls", async ()=>{
    assert.equal((await handler()(makeRequest(undefined, {
        Origin: "https://evil.test"
    }))).status, 403);
    const crossSite = await handler()(makeRequest(undefined, {
        "Sec-Fetch-Site": "cross-site"
    }));
    assert.equal(crossSite.status, 200);
    await crossSite.text();
    assert.equal((await handler()(makeRequest(undefined, {
        "Content-Type": "text/plain"
    }))).status, 415);
    const request = makeRequest();
    request.headers.delete("origin");
    assert.equal((await handler()(request)).status, 403);
});
test("rejects oversized bodies even without a Content-Length header", async ()=>{
    assert.equal((await handler()(makeRequest({
        messages,
        padding: "x".repeat(AI_LIMITS.bodyBytes)
    }))).status, 400);
    assert.equal((await handler()(makeRequest(undefined, {
        "Content-Length": "90000"
    }))).status, 400);
});
test("stream returns only allowlisted events and logs numeric usage, not prompts or secrets", async ()=>{
    const logs = [];
    const response = await handler({
        log: (entry)=>logs.push(entry)
    })(makeRequest());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const events = (await response.text()).trim().split("\n").map((line)=>JSON.parse(line));
    assert.deepEqual(events, [
        {
            type: "delta",
            text: "Test fixture response"
        },
        {
            type: "done"
        }
    ]);
    assert.equal(logs.length, 1);
    const log = logs[0];
    assert.equal(log.inputTokens, 20);
    assert.equal(log.outputTokens, 4);
    assert.equal(log.outcome, "completed");
    assert.ok(!JSON.stringify(logs).includes(env.OPENAI_API_KEY));
    assert.ok(!JSON.stringify(logs).includes(messages[0].content));
});
test("provider failures are sanitized and rate limits expose a retry interval", async ()=>{
    for (const status of [
        400,
        401,
        403,
        404,
        422,
        429,
        500
    ]){
        const response = await handler({
            provider: async ()=>{
                throw Object.assign(new Error("internal secret detail"), {
                    status
                });
            }
        })(makeRequest());
        const text = await response.text();
        assert.ok(!text.includes("internal secret"));
        assert.equal(response.status, status === 429 ? 429 : 502);
        if (status === 429) assert.equal(response.headers.get("retry-after"), "60");
    }
});
test("configuration diagnostics identify missing keys without exposing settings or repeating logs", async ()=>{
    const logs = [];
    const run = handler({
        env: {
            ...env,
            OPENAI_API_KEY: " "
        },
        log: (entry)=>logs.push(entry)
    });
    for(let i = 0; i < 3; i++){
        const response = await run(makeRequest());
        assert.deepEqual(await response.json(), {
            code: "unavailable"
        });
    }
    assert.equal(logs.length, 1);
    assert.equal(logs[0].diagnostic, "missing_api_key");
    assert.equal(configurationIssue({
        ...env,
        AI_ALLOWED_ORIGINS: "*"
    }), "invalid_ai_origins");
    assert.equal(configurationIssue({
        ...env,
        AI_ENABLED: "false"
    }), "feature_disabled");
    assert.equal(configurationIssue(env), null);
});
test("diagnostics distinguish credentials, model, quota, network and request failures without raw errors", async ()=>{
    const cases = [
        [
            401,
            undefined,
            "provider_authentication",
            "unavailable"
        ],
        [
            403,
            undefined,
            "provider_permission",
            "unavailable"
        ],
        [
            404,
            "model_not_found",
            "provider_model_unavailable",
            "unavailable"
        ],
        [
            429,
            "insufficient_quota",
            "provider_quota",
            "unavailable"
        ],
        [
            429,
            "rate_limit_exceeded",
            "provider_rate_limit",
            "rate"
        ],
        [
            400,
            undefined,
            "provider_request_invalid",
            "failed"
        ],
        [
            500,
            "private unknown code",
            "provider_failure",
            "failed"
        ]
    ];
    for (const [status, code, diagnostic, publicCode] of cases){
        const error = Object.assign(new Error("sensitive provider message"), {
            status,
            code
        });
        assert.deepEqual(classifyFailure(error, false), {
            code: publicCode,
            diagnostic,
            providerStatus: status
        });
        const logs = [];
        const response = await handler({
            provider: async ()=>{
                throw error;
            },
            log: (entry)=>logs.push(entry)
        })(makeRequest());
        assert.deepEqual(await response.json(), {
            code: publicCode
        });
        assert.equal(logs[0].diagnostic, diagnostic);
        assert.doesNotMatch(JSON.stringify(logs), /sensitive provider message|private unknown code|Help plan|unit-test-not/);
    }
    assert.equal(classifyFailure({
        name: "APIConnectionError"
    }, false).diagnostic, "provider_connection");
    assert.equal(classifyFailure({
        name: "APIConnectionTimeoutError"
    }, false).code, "timeout");
});
test("identity instructions cover truthful branding, languages, general help and text-only capabilities", ()=>{
    for (const phrase of [
        "developed by BlueMind",
        "OpenAI foundation model",
        "not the foundation model",
        "Arabic, Swedish and English",
        "Do not turn unrelated questions",
        "Image generation is not currently",
        "restaurant and business websites",
        "rather than pressure",
        "Never invent a price"
    ]){
        assert.ok(instructions.includes(phrase), `Missing instruction: ${phrase}`);
    }
});
test("SDK stream failures preserve only categorized diagnostics and never send done", async ()=>{
    for (const event of [
        {
            type: "response.failed",
            response: {
                error: {
                    code: "insufficient_quota",
                    message: "secret details"
                }
            }
        },
        {
            type: "error",
            code: "rate_limit_exceeded",
            message: "secret details"
        },
        {
            type: "response.incomplete",
            response: {}
        }
    ]){
        const provider = openAIProvider("unit-test-not-a-key", "gpt-5.4-mini", async ()=>new Response(`data: ${JSON.stringify(event)}\n\n`, {
                headers: {
                    "Content-Type": "text/event-stream"
                }
            }));
        const logs = [];
        const response = await handler({
            provider,
            log: (entry)=>logs.push(entry)
        })(makeRequest());
        const body = await response.text();
        assert.match(body, /"type":"error"/);
        assert.doesNotMatch(body, /secret details|"done"|insufficient_quota|rate_limit_exceeded/);
        assert.doesNotMatch(JSON.stringify(logs), /secret details/);
    }
});
test("partial stream failure never emits done", async ()=>{
    const provider = async ()=>(async function*() {
            yield {
                type: "delta",
                text: "Partial"
            };
            throw new Error("private details");
        })();
    const response = await handler({
        provider
    })(makeRequest());
    const text = await response.text();
    assert.match(text, /"code":"failed"/);
    assert.ok(!text.includes('"done"'));
    assert.ok(!text.includes("private details"));
});
test("empty and oversized provider responses cannot be marked completed", async ()=>{
    for (const text of [
        "",
        "x".repeat(AI_LIMITS.assistantChars + 1)
    ]){
        const provider = async ()=>(async function*() {
                if (text) yield {
                    type: "delta",
                    text
                };
                yield {
                    type: "done",
                    inputTokens: 1,
                    outputTokens: 1
                };
            })();
        const response = await handler({
            provider
        })(makeRequest());
        const body = await response.text();
        assert.ok(body.includes('"type":"error"'));
        assert.ok(!body.includes('"type":"done"'));
    }
});
test("disconnect aborts generation and releases the request slot", async ()=>{
    let aborted = false;
    const limiter = createLimiter();
    const provider = async (_, signal)=>(async function*() {
            yield {
                type: "delta",
                text: "Partial"
            };
            await new Promise((_, reject)=>signal.addEventListener("abort", ()=>{
                    aborted = true;
                    reject(Error());
                }));
        })();
    const response = await handler({
        provider,
        limiter
    })(makeRequest());
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(aborted, true);
    const next = await handler({
        limiter
    })(makeRequest());
    assert.equal(next.status, 200);
    await next.text();
});
test("timeout aborts the provider and releases the concurrency slot", async ()=>{
    let aborted = false;
    const limiter = createLimiter();
    const provider = async (_, signal)=>new Promise((_, reject)=>signal.addEventListener("abort", ()=>{
                aborted = true;
                reject(Error());
            }));
    const response = await handler({
        provider,
        timeoutMs: 10,
        limiter
    })(makeRequest());
    assert.equal(response.status, 504);
    assert.equal(aborted, true);
    assert.equal((await handler({
        limiter
    })(makeRequest())).status, 200);
    const upstreamTimeout = await handler({
        provider: async ()=>{
            throw Object.assign(new Error(), {
                name: "APIConnectionTimeoutError"
            });
        }
    })(makeRequest());
    assert.equal(upstreamTimeout.status, 504);
});
test("process limiter bounds concurrency, per-client rate and daily requests", ()=>{
    let now = 0;
    const limit = createLimiter(()=>now);
    const release = limit("a");
    assert.ok(release);
    assert.equal(limit("a"), null);
    release();
    release();
    for(let i = 1; i < 10; i++)limit("a")();
    assert.equal(limit("a"), null);
    now = 60001;
    limit("a")();
    const releases = [
        "b",
        "c",
        "d",
        "e"
    ].map((id)=>limit(id));
    assert.equal(limit("f"), null);
    releases.forEach((done)=>done());
    for(let i = 15; i < 200; i++){
        if (i % 20 === 0) now += 60001;
        limit(`id${i}`)();
    }
    assert.equal(limit("next"), null);
    now += 86400001;
    assert.ok(limit("next"));
});
test("official SDK adapter calls Responses with server instructions, bounded output and store:false", async ()=>{
    let sent = {};
    const fetcher = async (url, init)=>{
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        sent = JSON.parse(String(init?.body));
        const events = [
            {
                type: "response.output_text.delta",
                delta: "SDK fixture"
            },
            {
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 12,
                        output_tokens: 3
                    }
                }
            }
        ];
        return new Response(events.map((event)=>`data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: {
                "Content-Type": "text/event-stream"
            }
        });
    };
    const provider = openAIProvider("unit-test-not-a-key", "gpt-5.4-mini", fetcher);
    const output = [];
    for await (const event of (await provider(messages, new AbortController().signal)))output.push(event);
    assert.equal(sent.store, false);
    assert.equal(sent.stream, true);
    assert.equal(sent.max_output_tokens, 2000);
    assert.equal(sent.instructions, instructions);
    assert.deepEqual(sent.input, messages);
    assert.deepEqual(output, [
        {
            type: "delta",
            text: "SDK fixture"
        },
        {
            type: "done",
            inputTokens: 12,
            outputTokens: 3
        }
    ]);
    for (const price of [
        "499000",
        "899000",
        "1499000"
    ])assert.ok(instructions.includes(price));
    assert.ok(instructions.includes("Prices exclude VAT"));
});
