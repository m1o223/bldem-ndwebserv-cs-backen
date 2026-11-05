# Customer authentication

## Existing architecture, extended in place

- Next.js on Vercel owns the browser-facing `/api/customer/*` and Google routes.
- Node.js on the existing Render service owns authentication and database access.
- MongoDB `customerAccounts` is the user collection. Do not create a second `users` collection.
- Existing admin/employee workspace identities remain separate; a customer token never grants staff access.
- Email login uses the existing bcrypt cost-12 hashes (maximum 72 UTF-8 bytes).
- Google uses the official SDK, authorization code flow, PKCE S256, state, nonce, verified issuer/audience/email and stable Google `sub`.
- Matching email alone never links a Google identity to a password account.
- New Google users are created only after successful provider verification.

## User and session records

New users have UUID `_id`, email, displayName, profileImage (nullable), role `user`, status `active`, enabled, createdAt and updatedAt. Google profiles use allowlisted HTTPS Google image URLs only. Existing users without role/status retain the user/active interpretation only while enabled; explicit unsupported roles or inactive statuses fail closed. Profile updates cannot write role, status, identity, email or credentials.

Existing collections: customerAccounts, customerSessions, customerLoginLimits, customerGoogleFlows, customerProjects, customerNotifications. No SQL migration, new database, destructive migration or customer-data copying is required. Existing unique email/Google-subject and expiry TTL indexes remain. Added nonunique `customerSessions.customerId` index supports revocation cleanup, created idempotently when issuing sessions.

Sessions use 256-bit random tokens; only SHA-256 verifiers are persisted. The browser gets a host-only `__Host-bluemind_customer` cookie with HttpOnly, Secure, SameSite=Lax, Path=/, eight-hour lifetime. Responses are no-store. No token is put in localStorage, URL or response JSON by the frontend proxy. Password changes require the current password and a new passphrase of at least 15 characters and at most 72 bytes, use atomic compare-and-swap, increment credentialVersion, and delete customer sessions. Version checks also reject a concurrent login using old credentials.

## Authorization and request protection

Every protected page checks the session server-side, not only in a layout. Every customer API reads identity from the validated session, never a supplied customer ID. Database project/notification/profile queries are scoped to that identity. Role/status are checked on each session validation. Existing staff/admin authorization is unchanged and covered by the existing regression suite.

Frontend mutations require an exact same-origin production Origin and reject cross-site Fetch Metadata. Render customer routes never enable browser credentialed CORS; the Vercel server proxy uses the canonical production Origin. The legacy production Vercel origin remains accepted on Render for rollback compatibility, not arbitrary preview origins. Mongo-backed rate limits protect login, Google starts/callbacks and sensitive customer writes across instances. Request size limits and timeouts are enforced; upstream errors are sanitized.

## Production configuration

Render service: bluemind-web-service-backend.

- MONGODB_URI (existing secret)
- MONGODB_DB (existing database name)
- GOOGLE_AUTH_ENABLED=true
- GOOGLE_CLIENT_ID (existing OAuth client)
- GOOGLE_CLIENT_SECRET (Render only)
- GOOGLE_REDIRECT_URI=https://bluemindwebservice.com/api/auth/callback/google

Google Cloud must authorize exactly that HTTPS callback. Vercel serves the callback and exchanges through Render; it does not require the Google secret. The frontend's server proxy points to https://bluemind-web-service-backend.onrender.com. CUSTOMER_AUTH_BACKEND_URL is only an isolated loopback test override and is ignored on Vercel. Initial manual password provisioning variables remain optional and must not reset existing credentials. No payment/SMTP/AI environment changes are required.

## Callback diagnosis and session availability

`FRONTEND_URL` and `BACKEND_URL` are not used by this authentication implementation; the production origins above are pinned. Do not introduce cross-site browser cookies or wildcard credentialed CORS to fix a server-side callback failure.

The callback logs only categorical outcomes. Render logs token-exchange versus identity-verification failures with allowlisted provider error codes, never raw SDK errors, authorization codes, tokens, email addresses or request payloads. Vercel logs whether browser binding failed, the callback failed, linking is required, or a session cookie was set. A redirect back to sign-in with `google=link_required` means the verified Google email belongs to an existing password account; it does not mean the cookie disappeared. That case requires a separately authenticated linking flow, not automatic email-based linking.

Protected server pages and the client guard distinguish a confirmed 401 from a temporary backend/network failure. Only confirmed unauthenticated sessions redirect to sign-in; temporary failures hide protected content and offer retry while retaining the cookie. Browser auth requests explicitly include same-origin credentials. Reloading after a successful callback revalidates the Mongo-backed session.

## Release and verification

1. Run `npm test` in backend. Run frontend encoding/type checks, production build and isolated customer Playwright tests.
2. Review diff; commit only authentication-related changes. Push feature branches and fast-forward approved `main` only if GitHub has not advanced.
3. Deploy backend main on existing Render service, wait for live and check health/logs. No new service.
4. Deploy frontend main to existing Vercel `frontend` project; verify READY production aliases on bluemindwebservice.com and www redirect.
5. Test logged-out protected routes, CSRF rejection, invalid cookies, Google start and exact callback on the official domain.
6. A human must complete real Google consent/account selection. Confirm arrival at /dashboard, account page, logout, and rejection on browser back. Automated provider-double tests do not count as live Google verification.

Rollback frontend to its previous READY production deployment without changing secrets. Backend changes are additive. Before reverting to a backend that lacks credentialVersion checks, revoke all customer sessions through an approved maintenance operation; otherwise stale sessions from concurrent old-password logins could be accepted. Do not roll back or delete customer account/project data. Prefer a forward fix retaining session-version enforcement.

## Deliberately not implemented

BankID, self-service password recovery, Google/password account linking, profile-image uploads, account deletion and persisted AI conversations are not silently simulated. Password recovery directs users to BlueMind support. Google account security stays with Google. These require separate verified flows; existing unrelated pages remain present.
