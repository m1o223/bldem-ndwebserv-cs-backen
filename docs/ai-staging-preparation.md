# AI staging preparation: no production deployment

## Verified on 2026-10-22

- Render workspace: My Workspace (`tea-d6saoqsr85hc73epa0bg`).
- Existing service: `bluemind-web-service-backend` (`srv-db252acs728c73b4al2g`).
- Dashboard: https://dashboard.render.com/web/srv-db252acs728c73b4al2g
- Existing URL: https://bluemind-web-service-backend.onrender.com
- Repository: https://github.com/m1o223/bldem-ndwebserv-cs-backen
- Linked branch: `main`; automatic deploy on commit is enabled.
- Live deploy: `dep-db79d2ei0phs738r6d10`, commit
  `95e8335ffb144d0df0795adf3d84646adba51981`.
- Runtime: Node; region: Oregon; build: `npm ci`; start: `npm start`.
- Plan: free, one instance; PR previews are off. No staging service for this
  repository was listed, including previews.
- Prepared backend code: `f415670eb8e61b1bd7e0e84133561bd7df334e32`.
- Prepared frontend code: `9d50951ecb49d795adf99f127f0a76e583d6d489` in
  https://github.com/m1o223/bluem-ndwebs-rv-cefronend
- Both code commits are pushed to `feature/render-ai-integration`. Neither main
  branch was changed. No Render deployment or configuration mutation was made.

The Render connector exposes service/deployment details but no environment-variable
read operation. Current key presence and values could not be verified. Do not
describe variables as missing or configured based only on repository templates.
The Vercel connector returned project-not-found / an empty project list for the
known team, so its private environment and protection settings remain unverified.

## Staging release gate

The existing Render URL is the live backend, not a staging slot. Do not switch its
branch, manually deploy the feature SHA there, or enable AI on that service.

Render PR previews copy the parent service's settings, including environment
variables. Automatically cloning this service could therefore copy production
database, Stripe, email and authentication credentials. Do not create such a
preview with inherited secrets. Do not enable automatic previews for all PRs.

Before provisioning staging, obtain approval for an isolated temporary preview
instance of this SAME repository/code, including any costs. This is not a new AI
architecture and must not use the separate mobile application's backend. Select
a creation mechanism that supplies sanitized variables BEFORE the first start;
if that cannot be guaranteed, stop instead of starting an inherited preview.

Staging must have:

- Feature branch only, no production domain or production traffic.
- `AI_ENABLED=false` initially.
- No production MongoDB URI, payment keys/webhooks, email provider key, employee
  password hashes, session secrets or linked production environment groups.
- No seeds, migrations, order creation or payment requests during AI verification.
- Only AI and health exercised; unrelated integrations left unconfigured/failing
  closed. Existing production settings must never be edited to achieve isolation.
- Exact protected Vercel Preview origin in `AI_ALLOWED_ORIGINS`; no wildcard,
  production hostname, trailing slash or path. General `ALLOWED_ORIGINS` must not
  be broadened to permit AI access to unrelated APIs.
- Server-side access protection for authorized testers before enabling AI.
  A protected Vercel page alone does not protect a direct Render API. CORS is not
  authentication; in-memory quotas are not a public abuse/spend boundary.

Do not set Preview `NEXT_PUBLIC_AI_API_BASE_URL` to the production backend merely
to test this feature. Once staging exists, use its verified HTTPS origin and rebuild
only the feature-branch Preview. Leave the general API URL and Production variables
untouched. Do not put a secret in any `NEXT_PUBLIC_*` variable.

## Secret configuration by the owner

Revoke the key previously exposed in chat. Create a fresh, dedicated OpenAI project
key, with limited project access and usage monitoring. Never share it in chat.

After the staging instance is approved and identified, open its Render Environment
page and add these individually (do not import an existing production .env):

| Key | Staging preparation value |
| --- | --- |
| `OPENAI_API_KEY` | Fresh private key entered directly by the owner |
| `OPENAI_MODEL` | `gpt-5.4-mini`; model access still needs a real test |
| `AI_ENABLED` | `false` |
| `AI_ALLOWED_ORIGINS` | Exact verified protected Preview origin |

Choose **Save only**, not either deploy option. This stores values without starting
a deployment. If the final Preview origin is not known, leave the allowlist unset;
the route fails closed. Never use `*` to bypass this step.

If the owner wishes to stage the future production key on the existing service
now, the same four names can be saved there with `AI_ENABLED=false` and **Save
only**. This does not create staging or activate the endpoint, and must not change
any existing non-AI variables. Production deployment still requires approval.

## Verification and promotion gates

1. Deploy approved isolated staging with AI disabled; verify health, AI HTTP 503
   and unchanged denial of unrelated/private routes. Record its SHA and URL.
2. Verify server-side tester access, strict CORS, request/token limits, sanitized
   logs and no production integrations/secrets before enabling AI for testing.
3. With approval, enable AI only on protected staging and deploy configuration.
   Run real OpenAI greeting, context, identity, multilingual, retry/cancellation
   and desktop/mobile tests. Never replace failures with simulated replies.
4. Review billing/usage, model access and abuse controls. Disable staging AI after
   the test window if it will remain otherwise unattended.
5. Report the real results and request explicit production approval. Do not merge,
   promote, change live origins or remove the dormant Vercel path prematurely.

Prior local validation: 72 backend tests, 20 AI unit tests, 21 browser regressions,
4 cross-origin fixture tests, TypeScript and production build passed. These are
not evidence of a deployed Render connection or a real OpenAI response.

References checked during preparation:
- https://render.com/docs/service-previews
- https://render.com/docs/configure-environment-variables
