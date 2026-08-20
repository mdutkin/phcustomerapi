# PrimeRX data map — tables → our API → portal UI

How PrimeRX's MSSQL actually behaves, what each field means, and where it surfaces
in the patient portal. Written by matching live DB values against screenshots of
the PrimeRX Rx-Edit client (reference Rx: **5002619**, patient ZAKIROV RAVIL,
ATORVASTATIN CALCIUM 20MG). Everything marked ✅ was confirmed against the UI;
⚠️ marks an inference.

**PrimeRX has no API.** Its C# client writes directly to MSSQL, so we are strictly
read-only here. Patient-initiated changes become rows in our Postgres
`command_queue` for a pharmacist to apply by hand. Never write to MSSQL.

Keep this file updated as more of the client is mapped — it exists so nobody has
to re-derive column meanings from raw data again.

---

## 1. Two databases, one human

| DB | Meaning |
|----|---------|
| `PharmSQL` | 340B program |
| `PharmSQLCONVENTIONAL` | conventional pharmacy |

The same patient commonly exists in **both**, under **different `PATIENTNO`s** —
each database has its own sequence. They are not duplicates and there is no shared
key. Consequences, all of which have already caused bugs:

- Claim must link **both** records (match on verified phone + last name + DOB).
- "Ambiguous match" means >1 distinct `PATIENTNO` **within a single DB**, never across.
- `PATIENTNO` and `RXNO` are unique **per database** — always carry `dbKind` alongside.
- Reading only the primary link silently shows an empty portal: our test patient has
  0 prescriptions in 340B and 35 in Conventional.

---

## 2. CLAIMS — one row per fill (`RXNO` + `NREFILL`)

The prescription list collapses to the latest `NREFILL` per `RXNO`.

### 2.1 Status codes — `CLAIMS.STATUS`

| Code | Rows | Meaning | Confirmed |
|------|------|---------|-----------|
| `B` | 2,117,177 | **BILLED** — dispensed | ✅ Fill List prints "BILLED" + green badge |
| `F` | 96,123 | **Filed / Deferred** — on file, never dispensed | ⚠️ inferred |
| `U` | 1,439 | pre-billing (entered, not yet adjudicated) | ✅ audit shows `Rx Status: U → B` |
| `T` | 2,523 | unknown — do not guess | ❌ |

`F` is **not** "failed". PrimeRX ships a `FiledDeferredReason` lookup:

> 1 PA REQD · 2 REFILL TOO SOON · 3 PT REJECTED · 4 MEDICATION NOT COVERED ·
> 5 NEED CLARIFICATION · 6 REQUIERS SPECIALTY PHARMACY · 7 FILLED AT DIFFERENT
> PHARMACY · 8 MISSING INSURANCE INFO · 9 MEDICATION NOT AVAILABLE ·
> 10 NO ANSWER FOR DELIVERY · 11 PT IS IN HOSPICE · 12 PT IS IN SNFF · 13 IPA NEEDED

Some of those are *pending* states a patient would want to chase, not dead records.
`CLAIMS.FiledDeferredReasonID` FKs to it but is **NULL on ~94% of F rows**, so the
reason is optional — never assume it exists. Corroborating: F rows have no pickup
and no delivery; F averages $546 vs B's $168 (expensive drugs park awaiting prior auth).

→ API: `dispensed` (false when `F`) and `filedReason`.
→ UI: renders "On file — <reason>", excluded from **Current**.

### 2.2 Directions — `SIG` vs `SIGLINES`

`SIG` often holds pharmacist shorthand (`T1TPOQD`). `SIGLINES` holds the expansion
("TAKE 1 TABLET BY MOUTH DAILY"). ✅ The Rx tab shows the code in field 15 with the
expansion directly beneath. `SIGLINES` is blank on only **16 of 2,217,262** rows.

→ Always prefer `SIGLINES`, fall back to `SIG`.

### 2.3 Money — two layers, and one column that must never leak

Adjudication **overwrites** the amount columns. List price survives in `AWP`/`UnC`.
✅ Both layers confirmed, and the audit trail shows the transition
(`AMOUNT 164.79→0.71`, `PFEE 100.00→13.20`, `TOTAMT 264.79→13.91`).

| PrimeRX UI | Column | Rx 5002619 |
|---|---|---|
| (F)ill Recs → Ingredient Cost | `AWP` | $164.79 |
| (F)ill Recs → Dispensing Fee | *not stored* — derived `UnC − AWP` | $100.00 |
| (F)ill Recs → Usual & Custom | `UnC` (also `BAL`) | $264.79 |
| (P)ay Recs → Ingr.Cost Paid | `AMOUNT` | $0.71 |
| (P)ay Recs → Fee Paid | `PFEE` | $13.20 |
| (P)ay Recs → net total | `TOTAMT` (= AMOUNT + PFEE) | $13.91 |
| (P)ay Recs → Pat.Pay | `COPAY` | $0.00 |

> 🚨 **`COST` is the pharmacy's acquisition cost** ($0.77 against a $264.79 U&C).
> It appears on no screen and must never reach a patient-facing endpoint.

`COPAY` quality (last 12 months, 3,404 fills): 100% populated, 92.6% are $0.00,
avg $8.86 when non-zero, max $127.66. **Currently not exposed** — billing was cut
from portal scope. If ever shown, present it as "you paid $X" on a *historical*
fill only, never as a quote for a pending refill (adjudication is per-dispense;
deductibles reset, prior auth changes).

### 2.4 Pickup & delivery — the reliable source ✅

All confirmed 1:1 against the (Pl)ckup tab.

| PrimeRX UI | Column | Notes |
|---|---|---|
| Picked Up? | `PICKEDUP` | `Y`/`N` |
| Date Picked | `PICKUPDATE` | carries a junk midnight time component |
| Time Picked | `PICKUPTIME` | e.g. `02:41:19 PM` — the real time lives here |
| blue `DEL` label | `PICKUPFROM` | `M` counter 62,794 · `DEL` delivered 45,654 · `RTD` returned-to-dispensary 1,741 (B rows only) · `P` 15 |
| POS? | `PICKUPPOS` | |
| — | `DELIVERY` | `D` queued on a run → `Y` on handover |

Derived `handoff`:

```
PICKEDUP='Y' + (PICKUPFROM='DEL' or DELIVERY in Y/D/S) → "delivered"
PICKEDUP='Y' otherwise                                  → "picked_up"
PICKEDUP≠'Y' + DELIVERY='D'                             → "awaiting_delivery"  (in flight)
otherwise                                               → null
```

✅ The lifecycle is visible in the Track Rx audit: `DELIVERY ''→'D'` when queued,
then `DELIVERY 'D'→'Y'` + `PICKEDUP 'N'→'Y'` + `PICKUPFROM→'DEL'` all at handover.
~79 fills sit in `awaiting_delivery` at any time.

---

## 3. Delivery subsystem

`DELIVERY_ORDER` (the run) → `DELIVERY_DETAIL` (line items, keyed `RxNo` + **`RefillNo`**).
One run covers several prescriptions ✅ — a delivery slip for our test patient lists
3 Rx on one sheet.

> ⚠️ **The address belongs to the FILL, not the prescription.** Refills routinely go
> elsewhere: Rx `1098877` has 6 refills across 5 addresses; patients carry up to 8
> distinct addresses. Join on `RxNo` **and** `RefillNo`.

> ⚠️ **`DelStatus` / `DateDelivered` are unreliable.** Staff leave orders `O` with a
> NULL `DateDelivered` after delivering — all 3 of our test patient's completed
> deliveries look pending there. Use `CLAIMS` for *whether* it happened;
> `DELIVERY_ORDER` only for *where / who / when requested*.

Useful columns: `PATIENTADDRESS` (denormalised text; `DelAddress` is a numeric id),
`DelInstructions`, `ReqDelDate`, `DRIVER`, `DelAcceptedBy`, `Ship_TrackingNo`.
Addresses are free text and drift ("16808 Sherman Way" vs "…apt 104", inconsistent
commas) — for a future address-change feature, reconcile on the `DelAddress` id,
not string matching.

---

## 4. PATIENT & prescriber

`PATIENT`: `PATIENTNO`, `LNAME`/`FNAME`, `DOB`, `EMAIL`, `PHONE`/`MOBILENO`
(bare 10-digit), address parts, `ACTIVE` (treat blank as active; only `N` is inactive),
`primaryins`/`groupno1`/`medno1`, `ALLERGY` (free text, split on `,;/`).

Claim guards: a phone shared by more than 3 active patients is a placeholder and
proves nothing (legacy data has one number on 3,265 records).

Prescriber comes from `PRESNO` → name, NPI, phone ✅ (Rosenberg, Joshua / 1770226680
/ (818) 782-4300 matched exactly). It is **not** on the claim list row — detail only.

---

## 5. Tables that look useful but are dead

| Table | Why not |
|---|---|
| `RxPickupLog` | "who collected it" incl. relation — but **abandoned**: 22,709 rows in 2024 → **1 in 2026** |
| `RxDiagHistory` | ICD-10 indications — ~1% coverage, billing/prior-auth driven, and showing a diagnosis is a clinical decision |
| `Pharmacy` | 0 rows; it's a transfer directory, not our store record |
| workers' comp | no WC columns, no WC tables — the tab is unused here |
| `Delivery_Order_RemoteSignatureCaptureRequests` | 164 rows, external `1sign.co` signing URLs |

Medico's own details are **not in the DB** — hardcoded in
`phcustomerportal/src/lib/pharmacy.ts`, sourced from three independent printed
documents: **Medico Pharmacy, 11779 Santa Monica Blvd, Los Angeles CA 90025,
(310) 444-9011, fax (310) 444-0418**.

---

## 6. Rx-Edit tab → data

| Tab | Backing data |
|---|---|
| Rx | `CLAIMS` core + Fill List (`STATUS`, `PICKEDUP`) |
| (F)ill Recs | `AWP` / `UnC` list price |
| (P)ay Recs | `AMOUNT` / `PFEE` / `TOTAMT` / `COPAY` adjudication |
| (Pl)ckup | `PICKEDUP` / `PICKUPDATE` / `PICKUPTIME` / `PICKUPFROM` / `PICKUPPOS` |
| (Tr)ack Rx | audit trail — status transitions, delivery lifecycle, verifications |
| (Do)c | scanned docs incl. signed delivery slips (`D<YYMMDD><seq>`) |
| (DM)E | Medi-Cal billing qualifiers + `RxDiagHistory` |
| (W)orkman Comp | not stored anywhere; unused |
| (M)isc Info, (N)otes, (D)UR, (Im)munization, Clinical Info, Workflow | **not yet mapped** |

---

## 7. Portal presentation rules

Decisions that came out of the above and should not be silently reverted:

- **Current vs Past is split by dispense recency** (dispensed && last fill within
  ~180 days), *not* refills remaining. A medication filled three weeks ago with its
  last refill used is still what the patient takes daily — it needs a renewal, not
  archiving. Using refills as the axis collapsed a real 9-medication regimen to 1.
- **Status is phrased as an action.** "Refill now" (out of supply, refills
  authorised) — not "Out of medication", which contradicted "2 of 2 refills" beside it.
- **Missing data renders `—`.** Never invent a value.
- **`purpose` stays blank** — see `RxDiagHistory` above.
- Same drug under several `RXNO`s is normal, not duplication: when refills run out
  the pharmacy faxes a Refill Request naming the **old** RXNO and the prescriber
  authorises a **new** one ✅ (5001272 → 5002619). Chaining these generations into a
  single medication history is a good future feature.
