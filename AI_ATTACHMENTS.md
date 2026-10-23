# AI attachments

This extends only `/api/ai/chat` and adds `/api/ai/attachment-session` on the existing website backend. The separate mobile AI application is not involved.

## Data flow and privacy

- Vercel forwards attachment bytes to Render. Render validates and prepares actual image/document input for the existing OpenAI Responses API (`store: false`).
- Files remain in browser React memory for the current session. They are resent with follow-up context, not uploaded to public URLs or saved to MongoDB, disk, object storage, localStorage, or the OpenAI Files API.
- Parser work runs in one disposable, memory-limited worker at a time, with a 10-second timeout and cancellation. No file contents or names are logged. OpenAI's own processing/retention policies still apply; `store: false` is not a claim of zero provider retention.
- The existing public customer chat remains anonymous. A short-lived signed upload capability is issued to the Vercel proxy. It is not customer identity verification and is not returned to browser JavaScript. Origin checks are not a substitute for identity; independent global usage limits remain necessary.

## Supported content and limits

- Four files per conversation, 2 MiB per file, 2.5 MiB combined. Frontend session memory: 20 MiB of original file bytes. Request body: 3,700,000 bytes with a valid capability; ordinary text requests retain the previous 80,000-byte limit.
- JPEG, PNG, WebP: signatures and decoder formats must match. Maximum 16 megapixels; animated images rejected. Backend strips metadata and normalizes images to WebP, maximum 2048 pixels per dimension, for analysis. The viewer retains the original image.
- PDF: maximum 10 pages combined across the request. Encrypted/active-content PDFs rejected. Actual PDF bytes go to the model for page/text analysis.
- DOCX: main document text only. Headers, footers, comments, embedded pictures/charts and exact formatting are not included. Use PDF or screenshots when those details matter.
- UTF-8 TXT: nonempty readable text.
- XLSX: sheet names and cell values; formulas are not recalculated. Charts, images and layout are not analyzed. Maximum 10 sheets, 500 rows/sheet, 50 columns, 2,000 nonempty cells.
- Extracted text: 40,000 characters per file, 60,000 combined. Over-limit files are rejected, never silently truncated.
- Office ZIP packages: bounded entries/decompression, strict paths, no macros, embedded executable objects, encryption, external-link packages or XML entities.
- iOS HEIC and other unlisted formats are not supported. Native camera capture is offered where the browser/device can return a supported image.

## Abuse controls

Existing chat limits still apply. Additional attachment analysis limits are four requests/minute and 40/day across this service instance, including follow-ups and retries. Capability issuance is capped at 60/minute. These in-memory limits reset on restart and are not a guaranteed monetary budget. Keep provider-side project limits/alerts configured separately. No new paid services or persistent rate-limit store are introduced.

## Deployment and rollback

1. Run `npm test` and `npm audit --omit=dev`. Backend JavaScript has no separate compile step. Do not change production secrets.
2. Deploy the backend first through the existing main-branch auto-deployment. Confirm Render reports `live`, then verify `/api/health`, protected route rejection and attachment capability routing.
3. Deploy the tested frontend through its existing Vercel project. Verify the actual production chat with synthetic files and real OpenAI responses.
4. Roll back by reverting only the attachment release commit(s) and pushing to the respective main branches. Restore frontend first, then backend. Previous backend base: `960e38393c45960eb63c02c219d990ac1c4fbf49`; frontend base: `25d8f66d0a6b6be47f539d2ca785f62471a1d587`. Verify both replacement deployments. No database migration or storage cleanup is required.

Generate nonprivate test files using `node scripts/generate-ai-test-files.mjs <output-directory>`. Never use customer files or credentials in tests or test artifacts.
