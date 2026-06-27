# Portal Auth (Firebase) + Deployment Plan

Status: **planning / discussion.** v1 scope = sign-up + sign-in working in prod, on Firebase only.
Patient-claim (NextGen/PrimeRX matching) is OUT of this scope — it waits on NextGen API enrollment.
See `../../../nextgen/design/02-signup-identity-proofing.md` for the later claim flow.

## Decisions (agreed 2026-06-23)
- ✅ **Firebase is the sole source of truth for auth.** Full replacement — we DELETE the existing custom
  OTP + HS256 JWT + refresh-token code/tables in phcustomerapi. No coexistence ("bolting on") with the old auth.
- ✅ **Separate Firebase project** for the customer portal — **no intersection** with the phanalytics Firebase
  project (`phanalytics-419105`). Distinct user pool (patients vs analytics staff), config, and billing.
- ✅ **Phone-only sign-in for v1** (email+password deferred). Sign-up and sign-in are the same phone+SMS flow.
- ✅ **Prod DB: DigitalOcean Managed Postgres** (keeps the DB off the box; encryption + backups + PITR).
- ⏳ **Droplet resize: deferred** to post-go-live. ⏳ **Hostnames: TBD** (Max provides later; likely NOT
  ccchcenter.com).

## What Firebase owns vs what we own
- **Firebase:** sending/verifying the SMS code, session + token refresh, account recovery. We write none of it.
- **Us (phcustomerapi):** verify the Firebase ID token on each request; map UID → a `users` row; (later) map the
  user to a real patient via the claim flow.

## Workstream A — Firebase sign-up / sign-in

### A0 — Firebase project setup (prerequisite; needs Firebase console)
- Create a NEW Firebase project (e.g. `medico-portal`). **Max action** (or grant console access).
- Enable **Phone** sign-in provider; configure reCAPTCHA (required for web phone auth).
- Produce two artifacts:
  - **Web config** (apiKey, authDomain, projectId, appId, …) → consumed by phcustomerportal at build.
  - **Admin service-account JSON** → consumed by phcustomerapi backend (load from secret/env, NOT committed).
- Add the prod portal domain to Firebase **Authorized domains**.

### A1 — Backend (phcustomerapi)
- Add `firebase-admin`. Init with the service-account credential from a secret (env/file, not in git).
- Replace the `authenticate` plugin: verify `Authorization: Bearer <Firebase ID token>` via
  `admin.auth().verifyIdToken()`. On success, `req.user = { uid, phone_number }`.
- `users` schema: add `firebase_uid` (unique, not null) as the identity key; keep `phone_e164`. Drop password
  hash reliance.
- **Lazy provisioning:** on first authenticated request (or `GET /me`), upsert the `users` row by `firebase_uid`.
- **Delete** the custom auth surface: `auth.routes.ts` (otp/request, otp/verify, login/email, register/email,
  refresh, logout), the OTP + refresh-token tables, argon2 password logic. `/me` stays (returns the user;
  patient link is null until claim ships).
- Keep audit logging; audit `auth.login` on first-seen UID.

### A2 — Frontend (phcustomerportal)
- Add `firebase` web SDK. Initialize with the web config (from build-time env).
- Wire `Login.tsx` → `signInWithPhoneNumber` (invisible reCAPTCHA) → SMS code entry → `confirm(code)`.
- Auth context/provider + a route guard; persist session (Firebase handles token refresh).
- API client attaches `Authorization: Bearer <getIdToken()>`; refresh on 401.
- Sign-out. Unclaimed-state placeholder: signed-in but no patient link → "verify your identity — coming soon."

### A3 — v1 acceptance
- New patient: enter phone → SMS code → lands in portal with an account (users row, firebase_uid).
- Returning patient: same flow finds the existing row.
- Protected API routes reject requests without a valid Firebase token (401).

## Workstream B — Deployment

Reuse the proven systemd + nginx + certbot pattern from the phanalytics deploy on the ccchc box
(143.198.130.25). Differences: phcustomerapi is **Node** (systemd runs the built server) and needs **Postgres**.

### B1 — Postgres (prod) — DECIDED: DigitalOcean Managed Postgres
- DO Managed Postgres (encryption at rest, automated backups, PITR — eases HIPAA). DB lives **off the box**, so
  it also relieves the droplet (lets us defer the resize).
- phcustomerapi connects via `DATABASE_URL` (secret); enforce TLS (`sslmode=require`) + restrict the DB's
  trusted sources to the ccchc box IP.
- Run drizzle migrations against it (move off `db:push` for prod). Dev docker-compose PG stays dev-only.

### B2 — phcustomerapi service
- Build (tsc) → ship → `systemd` unit (Node, Restart=always), ordered After the Cato tunnel (for future
  PrimeRX) + Postgres.
- Secrets root-only (Firebase SA JSON, DATABASE_URL, later Twilio) via env file or systemd `LoadCredential`
  (same approach as the Cato credential).
- nginx reverse-proxy + certbot TLS at an **api** subdomain.

### B3 — phcustomerportal
- Vite build with build-time env: Firebase web config + API base URL.
- nginx static serve + certbot TLS at a **portal** subdomain.

### B4 — Cutover
- DNS A records → 143.198.130.25; certs; end-to-end smoke (sign up on prod, token reaches API, /me returns user).

### Deploy decisions
1. ✅ **Postgres: DigitalOcean Managed Postgres.** DB off-box; TLS-only; trusted-source = ccchc box IP.
2. ⏳ **Droplet resize: deferred** to post-go-live. Managed PG keeps the DB off-box, so the current
   1 vCPU / 1.9 GB box can carry the added Node API in the interim; resize when load justifies.
3. ⏳ **Hostnames: TBD** — Max provides later; **likely NOT ccchcenter.com.** portal + api hosts still resolve to
   the ccchc box (143.198.130.25) via DNS A records.

## Sequencing note
v1 here has **no NextGen/PrimeRX dependency** — pure auth + account creation. It can ship in parallel with the
NextGen enrollment wait. The claim flow (and its possession-proof OTP via Twilio) layers on later per
`02-signup-identity-proofing.md`.
