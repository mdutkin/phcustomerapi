# Architecture

## Goals

1. **Customer-facing only** — patient/portal endpoints. Pharmacy and clinician
   workflows live in separate services (`phanalyticsapi` for ops analytics, a
   future `phpharmstaff` for fulfillment).
2. **HIPAA-aware** — every read/write of PHI is audited; nothing PHI-shaped is
   logged in plain pino output.
3. **Type-safe wire** — request/response shapes are Zod schemas, surfaced into
   OpenAPI for both frontends to consume.
4. **Lean enough to ship fast** — no microservices, no message bus until we
   actually need one. Postgres + Fastify covers everything in the portal demo.

## Stack rationale

- **Fastify over Nest/Express** — TS-first, fastest plugin DX, no decorator
  overhead. Avoids Express's express-async-errors quirks.
- **Drizzle over Prisma** — generated TS types from schema files, no separate
  client process, no schema-drift surprises. Migrations are SQL files we read.
- **Zod over TypeBox** — already in our React projects (Login form uses it),
  keep one validator across the stack.
- **argon2id over bcrypt** — modern winner of the PHC contest; configurable
  memory cost.
- **JWT (HS256) + refresh rotation** — stateless access, stateful refresh
  with revocation. We can move to RS256 + JWKS once we have multiple consumers.

## Module shape

Each module owns its routes + service file:

```
modules/<aggregate>/
├── <aggregate>.routes.ts     # HTTP — Zod schemas, DB calls, audit
└── <aggregate>.service.ts    # Pure business logic, testable
```

Cross-cutting concerns (auth, error mapping, audit) are Fastify plugins under
`plugins/`. Database access is centralised in `db/client.ts`.

## Data flow

```
Client ──HTTPS──▶ LB ──HTTP──▶ Fastify ──▶ Service ──▶ Drizzle ──▶ Postgres
                                  │
                                  ├──▶ Audit log (PHI access)
                                  └──▶ pino (redacted, observability)
```

## Auth model

| Token   | Lifetime | Storage    | Rotates? | Revokable? |
|---------|----------|------------|----------|------------|
| Access  | 15m      | client RAM | no       | only by expiry |
| Refresh | 30d      | hashed in `refresh_tokens` | on every use | yes (set `revoked_at`) |

Refresh tokens are random 48-byte URL-safe strings, **not JWTs**. Storing
them as SHA-256 hashes means a DB leak doesn't compromise live sessions.

OTP codes are hashed with SHA-256, attempt-counted (max 5), and TTL'd at
`OTP_TTL_SECONDS` (default 5 min).

## Audit semantics

Every PHI-touching route calls `recordAudit(req, { action, resourceType,
resourceId?, patientId?, metadata? })`. Action verbs are dotted: `patient.read`,
`prescription.refill_request`, `lab_result.read`.

The table is intentionally append-only. Any retention policy must rotate to
cold storage rather than `DELETE`.

## What's *not* here yet (and why)

- **Pharmacy / fulfillment integrations** — out of customer-facing scope.
  When a refill is requested, we queue an internal task; downstream services
  consume it.
- **Real SMS provider** — `OTP_DEV_CODE=123456` keeps the dev loop tight.
  Twilio/MessageBird wires in via a single service call.
- **Stripe / payment processor** — `payment_methods` stores tokens, never
  PAN. The processor integration is gated behind a feature env.
- **WebSocket / push** — message threads are polled for now. Push channel
  comes in once the mobile app needs it.
