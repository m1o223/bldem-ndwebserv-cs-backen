# BlueMind Web Service AI integration

Prepared architecture: Vercel website -> this Render Node service -> OpenAI
Responses API -> streamed response to the website. The exact `/api/ai/chat` path
has its own CORS policy; existing orders, authentication, payments and MongoDB
routes retain their original behavior. No AI messages are stored in MongoDB.

## Configuration and activation

Use the existing Render service `bluemind-web-service-backend`, not the separate
BlueMind AI mobile backend. Do not create another service.

Revoke the credential previously shared in chat. Create a fresh, dedicated OpenAI
project key and enter it directly in Render's Environment editor. Never paste it
into chat, Git, frontend variables, command arguments or logs.

| Render variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Fresh private project key |
| `OPENAI_MODEL` | `gpt-5.4-mini` (verify project access before activation) |
| `AI_ENABLED` | `false` until approved activation, then `true` |
| `AI_ALLOWED_ORIGINS` | Comma-separated exact approved Preview origins |

Origins must include `https://` and must not contain paths, trailing slashes,
wildcards or credentials. Do not add Production until its release is approved.
Local non-production development can allow `http://localhost:3000`. Do not expand
the unrelated `ALLOWED_ORIGINS` list to make AI work.

Render Save only stages environment changes; they take effect on a subsequent
deployment. Saving and deploying immediately activates changes. This integration
also requires a code deployment. No live environment changes are included here.
The existing local server loads gitignored `.env`; `.env.example` contains names
and safe defaults only, not credentials.

Set Vercel Preview `NEXT_PUBLIC_AI_API_BASE_URL` to
`https://bluemind-web-service-backend.onrender.com` and rebuild that Preview. This
is a public URL, not a secret. Leave the website's general
`NEXT_PUBLIC_API_BASE_URL` unchanged. Do not place the OpenAI key on Vercel.

The old Vercel AI implementation remains dormant for comparison until a real
Render request succeeds. Its explicit legacy opt-in is disabled by default, and
setting the Render URL disables it regardless of that opt-in. There is no
automatic fallback from Render failures to Vercel execution.

## Guardrails and limits

- Exact-origin, JSON-only POST; preflight allows only POST and Content-Type.
- No cookies, credentials, client-selected model, provider URL, tools or prompts.
- 80 KB body limit, five-second upload deadline and eight intake/response slots.
- 4,000 characters per user turn; 12,000 per assistant turn; 20 turns and 18,000
  total context characters. Output is capped at 2,000 tokens / 12,000 characters.
- 55-second request deadline, 50-second SDK timeout, no automatic SDK retries.
- Browser disconnects cancel streaming/provider requests. Partial responses are
  never reported as completed; retries require explicit user action.
- Ten requests/minute and one active request per socket peer; four active
  requests, 20 requests/minute and 200 requests/day per process. Forwarding headers
  are not trusted, so Render proxy peers can share a conservative quota.
- Limits reset on restart and are NOT distributed limits or a hard spending cap.
  Review shared rate limiting, verified abuse controls and provider project usage
  controls before public activation. CORS is not authentication. Vercel Preview
  protection does not protect the publicly reachable Render API from scripts.
- Logs contain request IDs, allowlisted error categories/status, duration and
  completed-response token counts, never keys or message bodies. Failed or
  interrupted requests can still incur usage; consult provider billing records.
- `store:false` disables Responses application-state storage, not all provider
  retention. No private database access, uploads or image generation are enabled.

The existing BlueMind identity and multilingual, general-purpose website expertise
are preserved. Company grounding uses backend package/Care catalogs and the
verified policy snapshot in `src/ai/company-policy.js`; update that snapshot when
public policies change. Model answers still need factual review.

## Verification

Run `npm ci` and `npm test` here. Tests inject deterministic providers only through
test construction; production never selects test responses from an environment
flag. The suite includes real Node HTTP streaming, exact-origin CORS, unrelated
route isolation, validation, oversized/slow uploads, cancellation, timeouts,
retry, quota protection and existing backend regression tests.

In the frontend run `npm run test:ai-server`, `npm run typecheck`, `npm run build`
and `npm run test:ask-ai`. For the separate-process browser fixture:

```powershell
$env:NEXT_PUBLIC_AI_API_BASE_URL='http://127.0.0.1:4198'
npm.cmd run build
$env:AI_TEST_BACKEND_DIR='<absolute path to this backend worktree>'
npm.cmd run test:render-ai
Remove-Item Env:NEXT_PUBLIC_AI_API_BASE_URL
Remove-Item Env:AI_TEST_BACKEND_DIR
```

That fixture binds loopback only and refuses Render/Vercel execution. Its replies
are explicitly labeled test fixtures, not real OpenAI answers. Restore the desired
frontend environment and rebuild after testing.

## Approved rollout and rollback

1. Obtain deployment approval before pushing any branch wired to auto-deploy.
2. Configure Render with AI disabled, then deploy this reviewed backend revision.
   Verify health and existing routes; this service also serves existing features.
3. Stage the new key, model and approved Preview origin. Enable AI and deploy only
   when authorized. Configure/rebuild the protected Vercel Preview with the URL.
4. Run the frontend opt-in `REAL OpenAI` smoke and acceptance tests with
   `AI_LIVE_TEST=true` against that Preview. They make billed requests. Verify
   identity, multilingual responses, website help, memory, cancellation and retry.
5. Confirm streaming and errors in the real browser, review sanitized Render logs
   and provider usage, then remove the dormant Vercel implementation separately.
6. Do not promote the Preview or add Production origins without release approval.

Emergency AI rollback: set `AI_ENABLED=false` and deploy the configuration. This
turns off only AI. Restore the previous frontend deployment if required; do not
alter orders, payment records or unrelated environment variables.

References:
- https://render.com/docs/configure-environment-variables
- https://developers.openai.com/api/docs/guides/streaming-responses
