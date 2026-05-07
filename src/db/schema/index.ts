// Drizzle schema barrel — keeps imports tidy and gives drizzle-kit one entry point.
//
// Layout reflects the hybrid architecture:
//   - auth      → portal identity (PG)
//   - patients  → user-owned auxiliary data (PG: extra shipping addresses)
//   - links     → bridge to PrimeRX MSSQL (user_patients, refill_requests)
//   - labs      → stub until NextGen API integration (PG)
//   - shop      → OTC products + carts (PG)
//   - orders    → orders, deliveries, billing (PG)
//   - messages  → patient/pharmacy/doctor threads (PG)
//   - audit     → append-only audit log (PG)
//
// PrimeRX clinical data (PATIENT, PRESCRIB, DRUG, CLAIMS, RXEXTRA, INSCAR)
// is read-only via `src/db/mssql-models/*` — NOT mirrored here.

export * from "./auth";
export * from "./patients";
export * from "./links";
export * from "./labs";
export * from "./shop";
export * from "./orders";
export * from "./messages";
export * from "./audit";
