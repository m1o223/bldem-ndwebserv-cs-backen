# Google customer sign-in

Google Cloud OAuth client type: **Web application**.

Authorized redirect URI (exact, no trailing slash):

`https://bluemindwebservice.com/api/auth/callback/google`

Optional Authorized JavaScript origin: `https://bluemindwebservice.com`.
This implementation uses server-side authorization-code exchange, not a browser Google SDK.

Set these variables privately in the existing Render service
`bluemind-web-service-backend`, not in Vercel public variables or Git:

- `GOOGLE_CLIENT_ID`: Google Cloud web client ID.
- `GOOGLE_CLIENT_SECRET`: its secret.
- `GOOGLE_REDIRECT_URI`: the exact URI above.
- `GOOGLE_AUTH_ENABLED`: `true` only after all values and the consent screen are ready.

Save and redeploy Render after configuring them. No new service or database is required.
If the Google consent screen is in Testing, add permitted Google accounts as test users.
Do not paste credentials into chat. Until configured, Google sign-in fails closed with
an unavailable message; it never creates a fake login.

## Flow

1. The Google button POSTs to `/api/auth/google` on the official website.
2. Vercel forwards to Render `/api/customer/google-start`. Render creates a ten-minute
   single-use MongoDB flow containing PKCE and nonce, and hashes state/browser binding.
3. Vercel sets a Secure, HttpOnly, SameSite=Lax, host-only flow cookie and returns the
   Google authorization URL. No password or email form field is submitted.
4. Google returns the browser to the exact production callback above.
5. Vercel sends code, state and browser binding to Render `/api/customer/google-callback`.
6. Render atomically consumes the flow, exchanges the code using Google's official SDK,
   verifies signature/audience/issuer/expiry, nonce and verified email, then issues an
   existing customer-session token. Google access/refresh/ID tokens are not persisted.
7. Vercel sets the existing customer HttpOnly cookie and redirects to `/dashboard`.

Google users are keyed by Google's stable `sub`, not email alone. Matching an existing
password account's email **does not automatically link it**: a separate authenticated
linking flow is required before that account can use Google. No admin/employee account
is linked. New Google identities create customer accounts only after verified consent.

The password and BankID design previews remain unchanged. The Google button alone is
connected. Missing credentials do not affect existing password sessions or other APIs.

## Verification and rollback

Run `npm test` (isolated providers/databases), frontend build and customer Google browser
tests. After configuring Google, verify a real consent flow, dashboard session,
sign-out, return visit and cancellation. Mock-provider tests are not proof of real
Google authentication. Visiting the callback without state/cookie must reject with 400.

Set `GOOGLE_AUTH_ENABLED=false` and redeploy to disable Google without affecting existing
auth/payment/order code. Retain previous Render/Vercel deployment IDs for full rollback.
