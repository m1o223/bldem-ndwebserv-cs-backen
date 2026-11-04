# Customer workspace structure

This release develops the account page structure, not the later chat, identity-provider, billing or account-deletion integrations.

## Ownership and persistence

- Existing opaque customer sessions remain the only authority. The stable `customerAccounts._id` is used for all ownership queries; editable reply email and order number never grant access.
- Optional `customerType` is `null`, `private` or `company`. Omitting it during login leaves saved data unchanged and never blocks valid credentials. Profile settings can explicitly clear it.
- `fullName`, company details and four boolean notification preferences are saved on the same account. Email, credentials, roles and identity providers cannot be changed through profile updates.
- Future Google/BankID integration must link a verified provider subject to this stable account ID. No automatic merging by unverified email and no provider login implementation is included.

## Routes

- `GET /api/customer/overview`: sanitized profile, one current project, at most 20 recent notifications.
- `POST /api/customer/profile`: strict allowed-field validation, 30 writes per account per 15 minutes.
- `POST /api/customer/contact`: bounded validated message, 5 attempts per account per 15 minutes. Stored in the existing `contacts` collection with immutable `customerId` and forwarded via the existing team email notification helper. Receipt and email delivery outcomes are distinguished.
- All routes enforce the existing origin policy, authenticated customer session and no-store responses. The Vercel same-origin BFF keeps the session token HttpOnly and enforces CSRF checks. No new secrets or environment variables.

## Data awaiting operational integration

No project, invoice or notification is fabricated or imported by matching customer email. The read-only project adapter expects `customerProjects` documents explicitly assigned by `customerId` with `current: true`. No team project-editing workflow is implemented in this release.

Project stages are `idea`, `review`, `direction`, `development`, `testing`, `finalReview`, `delivery`; statuses are `completed`, `in_progress`, `not_started`. Progress is the completed stage count divided by seven. Amounts are nonnegative integer minor currency units; missing amounts remain absent, never zero-filled. Timeline entries contain text and a date. The projection excludes internal notes.

Notifications are read from `customerNotifications`, scoped to `customerId`, newest first. Automated event creation, read acknowledgement and email dispatch based on preferences are not implemented. UI says so.

No account chat storage, photo upload, password/email change, invoice access/payment actions, Google/BankID connection or account deletion is enabled. Destructive account deletion remains disabled pending review of reauthentication, explicit confirmation and retention requirements. Public pages and their AI chat are unchanged.

## Verification and rollback

Automated tests use isolated in-memory customer fixtures, never production customer, order or payment data. Verify missing type, saved type after a new session, cross-account isolation, read/write failure states, contact receipts, all seven stages, Arabic RTL, Swedish and mobile widths. Production smoke testing must not submit test enquiries or create projects.

Rollback frontend to commit `4bc7a62b0a8fd78184251b3ff25172c4d1ccfa4e` and backend to `f753d62d829446fb37df37d0d0b9a3b8f91c87ff` if needed. The data additions are backward-compatible and require no destructive migration. Existing sessions and account credentials remain unchanged.
