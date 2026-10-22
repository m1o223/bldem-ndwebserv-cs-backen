# Owner-only live AI testing

Production uses the existing Render service, not a staging service. No database
migrations, payment settings, or existing authentication routes are changed.

## Access

Keep `AI_ENABLED=false`. Set `AI_OWNER_TEST_ENABLED=true` only for the approved
testing period. `AI_ALLOWED_ORIGINS=https://bluemind-web-service.vercel.app`.
Keep the fresh `OPENAI_API_KEY` in Render and use `OPENAI_MODEL=gpt-5.4-mini`
unless an available model has explicitly been selected by the owner.

The website's AI-only session endpoint verifies the existing Workspace credentials
on Render. Only the authenticated administrator with stable employee ID `M` is
authorized. Other administrators, employees, and anonymous visitors are rejected.
No credentials or role changes are made. AI sessions do not authorize admin APIs.

Tokens are random, hashed in Render memory, expire after 30 minutes, and are
revoked by AI logout or a service restart. At most four sessions exist. The website
stores the opaque token in a Secure, HttpOnly, SameSite=Strict host-only cookie.
Login JSON responses never expose it to client JavaScript. CSRF origin checks and
exact backend CORS apply; CORS is not treated as authentication.

## Limits and observability

Five login attempts per minute per instance; one concurrent credential check.
Chat: 10 requests/minute per backend peer, 20/minute globally, one active request
per peer, four globally, 200 requests/day per instance. Maximum 2,000 output tokens,
18,000 context characters, 20 turns; 55-second provider deadline. In-process limits
reset on restart and are not a durable billing cap. Configure a restricted OpenAI
project key and provider usage alerts separately; budgets may not be hard stops.
Logs contain only request IDs, sanitized outcome classifications, duration and
token counts, never prompts, credentials, tokens, or raw provider exceptions.

## Deployment and rollback

Backend previous live commit: `95e8335ffb144d0df0795adf3d84646adba51981`.
Render previous live deployment: `dep-db79d2ei0phs738r6d10`.
Frontend baseline: `f18bf82e2c2be153ed34f0b49851e23d9bc38bef`.
Vercel baseline deployment: `dpl_BUYFmFs9jxYAJzUS2qHREDjVtZbX`.

Deploy only the isolated AI release commits, backend first. Verify health, public
AI denial, existing protected APIs and CORS before publishing the frontend.
Do not change ALLOWED_ORIGINS, database, Stripe, or existing auth secrets.

Emergency stop: set AI_OWNER_TEST_ENABLED=false and redeploy. Roll back Render
to the prior live deployment; roll back Vercel to its prior production deployment.
If platform rollback is unavailable, revert only these release commits on main
and let existing Git deployments rebuild. Never force-push main or roll back
database records. Rollback cannot undo already incurred provider usage.
Recheck public AI denial, health and order/payment routes after rollback.

Real provider verification must use a genuine owner login. Never fabricate an
owner session, retrieve production signing secrets, or copy the OpenAI key for
testing. Automated tests use clearly identified local fixtures only.
