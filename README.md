# phcustomerapi

Customer-facing API for **Medico Pharmacy** + **CCCHC** patient portal and mobile app.

Backs:
- [`mdutkin/phcustomerportal`](https://github.com/mdutkin/phcustomerportal) — React web portal
- [`mdutkin/phcustomerapp`](https://github.com/mdutkin/phcustomerapp) — mobile app (TBD)

## Stack

- **Node 20+** / **TypeScript** strict
- **Fastify 5** with `fastify-type-provider-zod` for runtime + typed schemas
- **PostgreSQL 16** via **Drizzle ORM** (typed schema, generated migrations)
- **JWT** access + refresh-rotation auth (`@fastify/jwt`)
- **argon2id** for password hashing
- **pino** structured logs (PHI-redacted)
- **OpenAPI** docs auto-served at `/docs`
- **vitest** for tests

## Quick start

```bash
cp .env.example .env                # generate JWT_SECRET first
docker compose up -d                # spins up Postgres on :5432
npm install
npm run db:push                     # apply schema directly (dev)
npm run db:seed                     # seed Margaret Chen demo persona
npm run dev                         # http://localhost:4000  (docs at /docs)
```

Login the seeded user:

```bash
# Phone OTP — dev mode returns the code in the response
curl -X POST localhost:4000/auth/otp/request \
  -H 'content-type: application/json' \
  -d '{"phone":"+14155550192"}'

# {"ok":true,"devCode":"123456"}

curl -X POST localhost:4000/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"+14155550192","code":"123456"}'
```

## Endpoints (current cut)

| Method | Path                          | Auth | Notes                                  |
|--------|-------------------------------|------|----------------------------------------|
| GET    | `/health`                     | —    | Liveness                               |
| POST   | `/auth/otp/request`           | —    | Issues an SMS OTP (dev: returned)      |
| POST   | `/auth/otp/verify`            | —    | Mints session                          |
| POST   | `/auth/login/email`           | —    | Email + password                       |
| POST   | `/auth/register/email`        | —    | Self-registration                      |
| POST   | `/auth/refresh`               | —    | Rotates refresh token                  |
| POST   | `/auth/logout`                | —    | Revokes a refresh token                |
| GET    | `/me`                         | ✓    | Patient demographics + insurance + addresses |
| GET    | `/prescriptions`              | ✓    | Active list                            |
| GET    | `/prescriptions/:id`          | ✓    | Detail + prescriber + refill history   |
| POST   | `/prescriptions/:id/refill`   | ✓    | Queues a refill (stub)                 |
| GET    | `/labs`                       | ✓    | Lab results list                       |
| GET    | `/labs/:id`                   | ✓    | Detail + history series                |
| GET    | `/shop/products`              | —    | OTC product list                       |
| GET    | `/shop/products/:id`          | —    | OTC product detail                     |

See `.planning/ROADMAP.md` for what's next.

## Layout

```
src/
├── app.ts                  # Fastify app builder
├── server.ts               # Entry — listen + graceful shutdown
├── config/env.ts           # Zod-validated runtime config
├── db/
│   ├── client.ts           # Drizzle + pg pool
│   ├── migrate.ts          # Migration runner
│   ├── seed.ts             # Demo data
│   └── schema/             # Per-aggregate schema files
├── lib/
│   ├── audit.ts            # Append-only audit log helper
│   └── crypto.ts           # argon2 + sha256 + random helpers
├── plugins/
│   ├── auth.ts             # @fastify/jwt + decorators
│   └── error-handler.ts    # Zod + HttpError → JSON
└── modules/
    ├── auth/
    ├── patients/
    ├── prescriptions/
    ├── labs/
    └── shop/
```

## Security & HIPAA notes

- **PHI in audit log**: every read/write of patient resources writes to `audit_log` with actor, IP, resource, and patient id. Never `UPDATE` or `DELETE` rows there in production.
- **Log redaction**: pino redacts `Authorization`, `Cookie`, and any `password*` / `token*` field from logs.
- **Refresh-token rotation**: every `/auth/refresh` revokes the prior token and issues a fresh one. Revoked or expired tokens fail closed.
- **TLS**: terminate at the LB. The API runs on plain HTTP behind it; `trustProxy: true` is enabled so client IP is preserved for audit.
- **Rate limit**: 200 req/min default; tune per route as needed.

## Scripts

| Script              | What                                         |
|---------------------|----------------------------------------------|
| `npm run dev`       | Watch mode with tsx                          |
| `npm run build`     | Emit `dist/`                                 |
| `npm start`         | Run compiled output                          |
| `npm run typecheck` | tsc --noEmit                                 |
| `npm run test`      | vitest                                       |
| `npm run db:push`   | Push schema (dev — no migration files)       |
| `npm run db:generate` | Generate SQL migration from schema diff    |
| `npm run db:migrate`  | Apply pending migrations                   |
| `npm run db:seed`     | Insert demo persona                        |
| `npm run db:studio`   | Drizzle Studio UI                          |
