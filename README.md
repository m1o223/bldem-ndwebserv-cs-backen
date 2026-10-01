# BlueMind Web Service — backend infrastructure

Dependency-free Node.js 22 health server. No database or business logic.

Run `npm ci`, copy `.env.example` to `.env`, then `npm run dev` (or `npm start`).
Validate with `npm test` and `curl -i http://localhost:4000/api/health`.

Only public endpoint: `GET /api/health`. Returns HTTP 200 with:
```json
{"success":true,"service":"BlueMind Web Service API","status":"healthy"}
```
Unknown routes return JSON 404; unsupported health methods return 405.

Deploy through the included Render Blueprint. Set `ALLOWED_ORIGINS` to the actual HTTPS Vercel frontend origin plus `http://localhost:3000`, comma-separated with no trailing slashes. Wildcards and missing allowlists fail startup. Render supplies PORT; bind address defaults to 0.0.0.0. No credentials are required.

After deployment, verify health HTTP 200, allowed Origin reflection, and rejected unknown origins. Local `.env` and production configuration are separate. Never commit environment files.
