# Message Card release

This is an additive AI presentation contract, not a new messaging service. It does
not send email, submit website orders, or write customer data.

## Contract

Clients opt in with `responseFormat: "message-card-v1"` alongside the existing
`messages` array. Without this capability the Responses API request and plain-text
NDJSON stream remain unchanged. Unknown formats are rejected.

For opted-in clients, the existing model may select the strict
`display_message_card` function schema. The adapter validates one title/body object
and emits `{"type":"message_card","card":{"title":"...","body":"..."}}`
only after successful provider completion, followed by the existing `done` event.
Incomplete arguments are never exposed. Ordinary text deltas continue streaming.
Existing timeouts, model, output limits, CORS and rate limits remain in place.

The website renders safe text, stores saved edits in its current conversation
state, and includes the current title/body as text in future context. Nothing is
persisted to a new database or browser storage. No credentials or new env vars.

## Release order and rollback

1. Run backend tests and frontend TypeScript, build and browser tests.
2. Deploy this additive backend commit to the existing Render service first.
3. Verify old text clients, structured drafts and safe error handling on Render.
4. Deploy the opted-in frontend to the existing Vercel project.
5. Verify real drafts, editing, clipboard/share paths and ordinary chat live.

Baseline backend: `0fa862f5e65ca08e5c4e109038aa2cb0ac901849`.
Baseline frontend: `2c6046318045a4b0d3622ae7b7e9ef30f6aac908`.
If reverting, restore the frontend first so it stops opting in, then revert this
backend commit if needed. Use scoped Git revert commits and the existing deploy
pipelines; never force-push or revert unrelated work. No data migration is required.
