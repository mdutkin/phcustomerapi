# Roadmap

## ✅ M0 — Foundation (this commit)

- [x] Fastify 5 + TS strict project
- [x] Postgres + Drizzle schema covering all aggregates the portal demos
- [x] OTP + email auth with refresh rotation
- [x] `/me`, prescriptions list/detail, labs list/detail, shop list/detail
- [x] Audit log (`audit_log`) wired into PHI reads
- [x] OpenAPI docs at `/docs`
- [x] Demo seed (Margaret Chen)
- [x] docker-compose for local Postgres

## 🚧 M1 — Patient flows

- [ ] **Cart + checkout** — `POST /cart/items`, `PATCH /cart/items/:id`,
      `POST /orders` (idempotent), order detail
- [ ] **Deliveries** — `GET /deliveries`, `POST /deliveries/schedule`,
      cancel/reschedule
- [ ] **Billing** — outstanding balance, payment, payment methods CRUD
- [ ] **Messages** — thread list, thread detail, send message,
      mark-as-read
- [ ] **Profile editing** — name/email/phone/addresses/insurance updates
- [ ] **Notifications** — push channel registration, preference matrix

## 🔮 M2 — Production-readiness

- [ ] Twilio (or MessageBird) SMS for OTP
- [ ] Stripe (or Adyen) tokenisation + payment intents
- [ ] Real prescriber/pharmacy directory ingestion
- [ ] Push notifications (APNs + FCM) for mobile app
- [ ] Pharmacy fulfillment task queue (BullMQ or Postgres-as-queue)
- [ ] Drizzle migration files versioned (drop `db:push` from prod)
- [ ] Per-route rate limits (auth endpoints lower than reads)
- [ ] CORS lockdown by environment
- [ ] OpenTelemetry traces + Sentry for errors

## 🛡 M3 — Security hardening

- [ ] WAF rules at LB
- [ ] Refresh-token reuse detection (revoke entire family)
- [ ] Field-level encryption for free-text PHI columns
- [ ] Audit-log retention + export to cold storage
- [ ] Pen test, then HIPAA risk assessment write-up

## ❓ Open questions

- **EHR integration?** If CCCHC has Epic / Athena / etc., we may need an
  HL7/FHIR adapter rather than the generic schema we have now.
- **Multi-tenancy?** Medico Pharmacy and CCCHC are separate brands but the
  patient overlap is high. Single DB with tenant column or two deployments?
- **PCI scope?** If we tokenise via Stripe Elements, we stay SAQ-A. Anything
  pre-tokenisation drags us into SAQ-D — avoid.
