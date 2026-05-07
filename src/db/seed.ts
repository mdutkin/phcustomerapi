// Seed the local DB with the same demo persona the portal already uses.
// Run with: npm run db:seed (after `npm run db:push`).

import { db, pool } from "./client";
import {
  patients,
  prescribers,
  pharmacies,
  prescriptions,
  drugs,
  labResults,
  otcProducts,
  insurancePlans,
  addresses,
  users,
} from "./schema";
import { hashPassword } from "@/lib/crypto";

async function main() {
  // eslint-disable-next-line no-console
  console.log("Seeding database…");

  // ─── User + Patient ────────────────────────────────────────────────────
  const [user] = await db
    .insert(users)
    .values({
      email: "margaret.chen@example.com",
      phoneE164: "+14155550192",
      passwordHash: await hashPassword("changeme123"),
    })
    .returning();
  if (!user) throw new Error("user seed failed");

  const [patel] = await db
    .insert(prescribers)
    .values({
      name: "Dr. Rohan Patel, MD",
      specialty: "Internal Medicine",
      clinic: "Bay Family Health, San Francisco",
      phone: "+14155550119",
    })
    .returning();
  if (!patel) throw new Error("prescriber seed failed");

  const [maple] = await db
    .insert(pharmacies)
    .values({
      name: "Maple St. Pharmacy",
      address: "240 Maple St, San Francisco, CA 94109",
      phone: "+14155550140",
    })
    .returning();
  if (!maple) throw new Error("pharmacy seed failed");

  const [patient] = await db
    .insert(patients)
    .values({
      userId: user.id,
      firstName: "Margaret",
      lastName: "Chen",
      dob: "1953-03-14",
      phoneE164: "+14155550192",
      email: "margaret.chen@example.com",
      preferredPharmacyId: maple.id,
      primaryPrescriberId: patel.id,
      allergies: ["Penicillin", "Sulfa drugs"],
      conditions: ["High cholesterol", "Hypertension", "Type 2 diabetes"],
    })
    .returning();
  if (!patient) throw new Error("patient seed failed");

  await db.insert(addresses).values({
    patientId: patient.id,
    label: "Home",
    line1: "1428 Sutter St, Apt 4B",
    city: "San Francisco",
    state: "CA",
    postalCode: "94109",
    isDefault: "true",
  });

  await db.insert(insurancePlans).values({
    patientId: patient.id,
    plan: "Blue Shield PPO",
    memberId: "BSC-42-9173-08",
    groupId: "GRP-118840",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });

  // ─── Drugs + Prescriptions ─────────────────────────────────────────────
  const [atorva] = await db
    .insert(drugs)
    .values({
      name: "Atorvastatin",
      genericName: "atorvastatin calcium",
      form: "tablet",
      strength: "20 mg",
      uses: "Lowers LDL cholesterol",
    })
    .returning();
  if (!atorva) throw new Error("drug seed failed");

  await db.insert(prescriptions).values({
    patientId: patient.id,
    drugId: atorva.id,
    prescriberId: patel.id,
    rxNumber: "RX48119",
    sig: "Take 1 tablet by mouth once daily at bedtime",
    qtyPerFill: 30,
    daysSupply: 30,
    refillsTotal: 5,
    refillsRemaining: 3,
    purpose: "Lowers LDL cholesterol",
    status: "refill_available",
    pricePerFill: "8.40",
    lastFilledAt: "2026-04-09",
    nextRefillAt: "2026-05-09",
  });

  // ─── Lab results ───────────────────────────────────────────────────────
  const labRows = [
    { code: "TCHOL", name: "Total cholesterol", cat: "Lipid panel", value: "215", unit: "mg/dL", flag: "H" as const, refLow: "0", refHigh: "200" },
    { code: "HDL", name: "HDL cholesterol", cat: "Lipid panel", value: "58", unit: "mg/dL", flag: "OK" as const, refLow: "40", refHigh: null },
    { code: "LDL", name: "LDL cholesterol", cat: "Lipid panel", value: "132", unit: "mg/dL", flag: "H" as const, refLow: "0", refHigh: "100" },
    { code: "A1C", name: "Hemoglobin A1c", cat: "Diabetes", value: "5.9", unit: "%", flag: "OK" as const, refLow: "0", refHigh: "6.5" },
  ];
  for (const lab of labRows) {
    await db.insert(labResults).values({
      patientId: patient.id,
      testCode: lab.code,
      testName: lab.name,
      category: lab.cat,
      source: "Quest Diagnostics",
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
  console.log("Seed complete.");
  await pool.end();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", err);
  await pool.end();
  process.exit(1);
});
