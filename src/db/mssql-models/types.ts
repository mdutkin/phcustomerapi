// Shared types for MSSQL read models. Keep these focused on what the
// portal actually needs to render — we don't try to model 124 columns of
// the PATIENT table. Add fields when the UI needs them.

import type { DbKind } from "../schema/links";

export type { DbKind };

export interface PrimeRxPatient {
  patientno: number;
  lastName: string | null;
  firstName: string | null;
  middleInitial: string | null;
  dob: Date | null;
  sex: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  active: boolean;
  is340b: boolean;
  primaryInsurance: string | null;
  primaryGroupNo: string | null;
  primaryMemberNo: string | null;
  allergies: string | null;
  language: string | null;
}

export interface PrimeRxPrescriber {
  presno: number;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  npi: string | null;
  dea: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  active: boolean;
}

export interface PrimeRxDrug {
  ndc: string;
  name: string | null;
  brandName: string | null;
  genericName: string | null;
  form: string | null;
  strength: string | null;
  units: string | null;
}

export interface PrimeRxClaim {
  rxno: string;             // BIGINT serialised to string to avoid JS truncation
  refillNo: number;          // NREFILL — fill cycle index
  totalRefills: number;      // TREFILLS — total refills authorised
  patientno: number;
  presno: number | null;
  ndc: string | null;
  drgname: string | null;
  status: string | null;
  dateWritten: Date | null;  // DATEO
  dateFilled: Date | null;   // DATEF
  daysSupply: number | null;
  qtyOrdered: number | null;
  qtyDispensed: number | null;
  sig: string | null;
  sigLines: string | null;
  pickedUp: boolean;
  pickupDate: Date | null;
  totalAmount: string | null;  // money — keep as string for precision
  copay: string | null;
  is340b: boolean;
  delivery: boolean;
}

export interface PrimeRxInsurance {
  icCode: string;
  name: string | null;
  binNo: string | null;
  payorId: string | null;
  copay: string | null;
  notes: string | null;
}
