// Seeds the local PG database with a demo portal user and a small set
// of OTC products. Clinical data (prescriptions, drugs, prescribers,
// patient demographics, insurance) is NOT seeded — it lives in the
// PrimeRX MSSQL databases. To exercise the full /me + /prescriptions
// flow against real data, run:
//
//   1. Open the MSSQL tunnel:  npm run tunnel:mssql
//   2. Seed PG:                npm run db:seed
//   3. Sign in via OTP/email and call POST /me/claim with real
//      lastName + dob + phone of an existing PrimeRX patient.
//
// Lab results stay seeded as a STUB until NextGen integration lands.

import { db, pool } from "./client";
import { labResults, otcProducts, users } from "./schema";
import { hashPassword } from "@/lib/crypto";

async function main() {
  // eslint-disable-next-line no-console
  console.log("Seeding database…");

  const [user] = await db
    .insert(users)
    .values({
      email: "margaret.chen@example.com",
      phoneE164: "+14155550192",
      passwordHash: await hashPassword("changeme123"),
    })
    .returning();
  if (!user) throw new Error("user seed failed");

  // ─── Lab results (STUB until NextGen API integration) ──────────────────
  const labRows = [
    { code: "TCHOL", name: "Total cholesterol", cat: "Lipid panel", value: "215", unit: "mg/dL", flag: "H" as const, refLow: "0", refHigh: "200" },
    { code: "HDL", name: "HDL cholesterol", cat: "Lipid panel", value: "58", unit: "mg/dL", flag: "OK" as const, refLow: "40", refHigh: null },
    { code: "LDL", name: "LDL cholesterol", cat: "Lipid panel", value: "132", unit: "mg/dL", flag: "H" as const, refLow: "0", refHigh: "100" },
    { code: "A1C", name: "Hemoglobin A1c", cat: "Diabetes", value: "5.9", unit: "%", flag: "OK" as const, refLow: "0", refHigh: "6.5" },
  ];
  for (const lab of labRows) {
    await db.insert(labResults).values({
      userId: user.id,
      testCode: lab.code,
      testName: lab.name,
      category: lab.cat,
      source: "Quest Diagnostics (stub)",
      collectedAt: new Date("2026-04-24T08:30:00Z"),
      value: lab.value,
      unit: lab.unit,
      flag: lab.flag,
      refLow: lab.refLow,
      refHigh: lab.refHigh,
    });
  }

  // ─── OTC products ──────────────────────────────────────────────────────
  await db.insert(otcProducts).values([
    { sku: "TYL-500-100", name: "Acetaminophen 500 mg", brand: "Tylenol Extra Strength", category: "Pain & Fever", pack: "100 caplets", price: "12.99", rating: "4.7", iconKey: "pill", inStock: true },
    { sku: "ADV-200-200", name: "Ibuprofen 200 mg", brand: "Advil", category: "Pain & Fever", pack: "200 tablets", price: "14.49", salePrice: "11.99", rating: "4.6", iconKey: "pill", inStock: true },
    { sku: "CLA-10-30", name: "Loratadine 10 mg", brand: "Claritin 24 Hour", category: "Allergy", pack: "30 tablets", price: "18.99", rating: "4.5", iconKey: "leaf", inStock: true },
    { sku: "BPM-OMRON", name: "Upper arm BP monitor", brand: "Omron Silver", category: "Daily Living", pack: "1 unit", price: "64.99", rating: "4.6", iconKey: "activity", inStock: true },
  ]);

  // eslint-disable-next-line no-console
  console.log("Seed complete. Demo user:", user.email);
  // eslint-disable-next-line no-console
  console.log("Next: claim a real PrimeRX patient via POST /me/claim.");
  await pool.end();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", err);
  await pool.end();
  process.exit(1);
});
