# Customer AI access

This release supersedes the owner-only test gate described in ai-owner-release.md.
The customer explicitly approved anonymous website chat. /api/ai/chat accepts
validated text conversations without customer accounts. /api/ai/session is removed.
The AI-only owner session module is removed. Existing Workspace authentication,
employee permissions, customer data, payment routes, and database code are unchanged.

Set AI_ENABLED=true in the existing Render service after the approved release.
Keep the existing OpenAI key server-side; AI_ALLOWED_ORIGINS remains the exact
public website origin. AI_OWNER_TEST_ENABLED is obsolete and should remain false.

CORS is a browser restriction, not user authentication or bot protection. The
endpoint is intentionally public. Existing limits still apply: 10 requests/minute
per transport peer, 20/minute globally, 200/day per process, one simultaneous request
per peer/four globally, 2,000 maximum output tokens, bounded context, request-body
limits and deadlines. Shared proxy peers may share quotas. In-memory quotas reset
on restart; they are not durable spending caps. No additional paid services added.

The assistant explains ordering but has no tools or access to private order data,
payment actions, customer accounts, or the admin system. Never add such access to
anonymous chat without a separate verified authorization design.

Rollback: set AI_ENABLED=false and redeploy to stop paid execution. Revert only
this customer-access release, or restore Render 4f2679d and Vercel 8ef7ad7, restoring
their prior AI flags if owner testing is needed. No database rollback is required.
