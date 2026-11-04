# Customer area, phase one

Customer authentication is separate from admin/employee sessions. Existing orders,
payments, workspace permissions and AI routes are unchanged.

## Storage and limits

- customerAccounts: normalized unique email, display name, enabled, bcrypt (cost 12).
- customerSessions: SHA-256 of a random 256-bit token, customer ID and eight-hour expiry.
- customerLoginLimits: atomic 15-minute counters; five attempts per account,
  100 total login attempts. TTL cleanup; expiry is checked independently.
- No passwords, tokens or email addresses are logged by the new endpoints.
- Vercel sets a Secure, HttpOnly, SameSite=Lax, host-only customer cookie.
- Every private page revalidates through Render. Logout revokes the stored session.
- Google, Swedish BankID and recovery remain unconnected; no simulated success.

## Manual account creation

From an authorized interactive terminal with the existing MongoDB configuration:

```sh
node --env-file-if-exists=.env scripts/create-customer.mjs
```

Passwords are entered without terminal echo. The command only inserts new customer
accounts and refuses to overwrite existing ones. Never paste passwords into chat,
shell arguments, Git, or logs.

For a hosting plan without a shell, an authorized operator can temporarily set
CUSTOMER_INITIAL_EMAIL and CUSTOMER_INITIAL_PASSWORD_HASH (bcrypt cost 12).
The next valid-shaped login request creates that account if absent, never resets
an existing account. Remove/empty both variables after verification. No plaintext
password belongs in Render environment variables. This is operator provisioning,
not a public registration endpoint.

## Release and rollback

Deploy the backend before the frontend. Verify health/pricing and existing tests.
Verify private routes redirect anonymous users, then test the real approved account.
If necessary restore the previous backend and frontend commits; do not delete
customer collections or modify orders. Previous releases ignore these collections.
No new paid resource, service, database or authentication provider is required.
