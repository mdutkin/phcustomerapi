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
| `T` | 2,523 | **Transferred out** — `RefDueView`'s source reads `clm.STATUS = 'T'` as `IsTransfered`, gated by `DEF0001.ALLOWTRRXREF` (Y here, so transferred Rx are not blocked from refill) | ✅ (from view source, 2026-09-15) |

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

**Dates are calendar dates, not instants.** PrimeRX stores fill/due/pickup/DOB with no time
of day; the driver returns them as midnight **UTC**. `new Date("2026-08-26")` in a Los Angeles
browser is 5pm on Aug 25, so every such date rendered a day early until 2026-09-15. Rule: the
API ships calendar dates as `YYYY-MM-DD`, and the portal parses those (and midnight-UTC
timestamps) as local calendar dates via `lib/dates.ts`. Never `new Date(iso)` an API date in
the portal directly.

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

---

## 8. Queues & workflow (partially mapped — 2026-08-26)

PrimeRX ships a configurable workflow engine, and Medico has defined two
workflows (`WF_Workflow`): **"MEDICO WORKFLOW"** (2019) and "MEDICO WF 2" (2021).

**States** (`WF_State`, ordered per workflow by `WF_QueueOrder.SerialNo`):

```
main line   START → DATA ENTRY → PV1 → DRUG PICK VERIFICATION → PRINT LABEL
            → PV2 → DISPATCHER → WAITING BIN / DELIVER BIN → COMPLETED
exceptions  CALL PATIENT · CALL DOCTOR · REFILL TOO SOON · PRIOR AUTH QUEUE
            · (OOS) OUT OF STOCK · HOLD RX/WAITING FOR OTHER RX · CHEMO TECH
```

`PV1`/`PV2` and `DRUG PICK VERIFICATION` line up with the Verifications block on
the Track Rx tab (`DrugPickVarifLog`, `PharmVerifLog`), so those states are real
and exercised.

Other queue machinery, with live row counts:

| Table | Rows | What it is |
|---|---|---|
| `RefDueView` / `RefDueRep` | 1,878 / 2,501 | **Refills due** — RXNO, last fill, `Duedate`, `DaysRemaining`, `QtyRemaining`. The pharmacy's own version of the "needs a refill" calculation our portal derives from days-supply. |
| `EREQUEST` | 40,545 | Electronic prescriber requests. `MSGTYPE='REFREQ'` = refill request sent to the doctor — the electronic sibling of the faxed Refill Request. |
| `PRESMSG` | 110,531 | Prescriber messaging |
| `MessagingQueue` (+`MessagedQueueDetail`, `…History`) | 567 / 82k / 59k | Messaging — relevant if we ever do patient↔pharmacy chat |
| `LabelQueue` | 11 | Live label-print queue |
| `TM_Task`, `TM_Queue*` | ~1 | Task management (barely used) |
| `MO_QueueCodeLookup` | 26 | Status codes for partner workflows (`Abarca`, `APS`) — e.g. IN PROGRESS, BILLED, READY FOR SHIPPING, DELIVERED; APS adds Profile Review, Pharmacist Verification, Prior Auth-ish lanes |
| `IntakeQueue` | **0** | Schema exists (BatchId, QueueId, RxNo, MORxStatus, ExpectedPickupTime, Priority, FullfillmentStatus) but is EMPTY |

### ⚠️ The open question
`CLAIMS` has **no workflow/state column**, and `IntakeQueue` is empty — so from the
database alone we cannot tell **which queues Medico actually works day to day**
versus which are configured-but-unused. `WF_*` is configuration; the runtime
linkage was not located. Resolve this from the PrimeRX UI (queue screens with
live counts) before designing the staff console.

### Design implication for the patient portal
We are read-only on MSSQL, so patient requests can never be written into these
queues. But two things follow:
- **Speak their vocabulary.** Our `command_queue` should map onto states staff
  already recognise (CALL PATIENT, REFILL TOO SOON, PRIOR AUTH QUEUE) rather than
  inventing a parallel taxonomy.
- **Auto-reconcile instead of double-handling.** When a pharmacist actions a
  refill in PrimeRX a new `CLAIMS` row appears (and `EREQUEST`/`RefDueView` move).
  Our queue item can close itself off that signal, so staff never have to mark
  anything done twice in a second system.

### Live Workflow panel (confirmed from the UI, 2026-08-26)
PrimeRX's "Live Workflow" side panel is the queue view staff actually work, and
every count on it maps to a column in **`LiveWorkflow_Counter`** — a cached
counter row per `StationId` (36 here), refreshed periodically (`LastUpdate`):

| Panel | Column | Seen |
|---|---|---|
| Intake · ERx / Doc Queue / **Refill Queue** | `INewRxCount` / `IDocQueueCount` / **`IRphCount`** | 0 / 0 / **1140** |
| Billing · Unbilled / PA Queue / DUR-DDI / Refill Too Soon | `BUnbilledCount` / `BRejQueue1Count` / `BRejQueue2Count` / `BRejQueue3Count` | 0 / 0 / 1 / 0 |
| Verification · Drug Pick / RPH | `VDrugPickVerifCount` / `VRPHVerifCount` | 6 / 6 |
| Pickup · **Rx(s) Ready** / Delivery Bin / **In Transit** / Unpicked >14d | `PAllUnpickBilledCount` / `PTotalDeliverBinCount` / `PInTransit` / `PUnpickedover14Days{Billed,Unbilled}Count` | 11 / 16 / 302 / 8+3 |

So the workflow IS actively worked (the earlier doubt is resolved), and the
refill queue is the busiest lane by far.

⚠️ **Our derived states approximate these counts but do NOT replicate them.**
Over the last 30 days of fills we derive ready_for_pickup=6 (panel: 11) and
awaiting_delivery=56 (panel: Delivery Bin 16 / In Transit 302) — different
windows and extra criteria we haven't reverse-engineered. Consequences:
- For per-patient status this is fine, and we bias conservative: we only say
  "Ready for pickup" for a billed, uncollected fill that is NOT on a delivery
  run. A false negative is silence; a false positive sends a patient to the
  pharmacy for nothing.
- **A staff console must READ `LiveWorkflow_Counter` rather than recompute**, or
  staff will see two different numbers for the same queue and stop trusting ours.

`PICKEDUP` is only reliably populated on recent rows (~1.99M historical CLAIMS
have it NULL), so anything "waiting" MUST be date-bounded — PrimeRX bounds its own
panel with a `From:` date for the same reason.

### ERx Action List → `EREQUEST` (confirmed from the UI, 2026-08-26)
The ERx Action List is the prescriber-messaging queue. Reconciled exactly against
a screenshot: the 6 rows shown are the REFREQs with **blank `TRANSSTAT`**, and a
7th (older) row is excluded by the screen's `From Date Received` filter.

| Column | Values |
|---|---|
| `MSGTYPE` | `RXFill` 20,924 · **`REFREQ`** 16,225 (refill request to prescriber) · `CANRES` 3,373 · `RXCHG` 22 |
| `TRANSSTAT` | **`''` = Awaiting Response** · `C` closed 32,367 · `E` 5,851 · `I` 2,022 |

This is the other half of the refill story: when an Rx runs out of refills the
pharmacy sends a REFREQ and waits on the doctor. Surfaced to patients as
"Renewal requested" instead of a bare "No refills left".

⚠️ **`TRANSSTAT` is only closed when staff action the row, so old blank rows are
STALE, not pending.** Our test patient has REFREQs from January and March still
blank although both were renewed into new Rx numbers (5001271→, 5001272→5002619).
PrimeRX copes by filtering its own screen to recently-received messages; we bound
ours to 45 days for the same reason. An unbounded read would tell patients their
doctor has been sitting on a request for seven months.

### Delivery Queue screen (confirmed from the UI, 2026-08-26)
The "PrimeRx - Delivery Queue" tab lists **Open Orders** from `DELIVERY_ORDER`,
filtered by `ReqDelDate`. Reconciled against a screenshot (From 08/22 To 08/25):
the DB has 15 orders in that window, all `DelStatus='O'`; the screen showed 9
because **"Show verified Rx(s)" / "Show billed Rx(s)"** were ticked, i.e. it only
lists orders whose prescriptions are ready to go out.

- **`DelStatus`: `O` = Open** (7,377) — sitting in this queue; `C` = closed (15,409).
  This is why `DelStatus` is useless as a "was it delivered" signal: staff deliver
  without finalising, so orders stay Open indefinitely. Our test patient's
  completed July deliveries are still `O`.
- **`DeliveryMethod`: `D` = Delivery (20,589), `S` = Shipping (2,295)** — matches the
  screen's colour legend (blue = delivery, orange = shipping, red = invalid address).
- **`ReqDelDate` = the requested/promised delivery date** — the single most useful
  field for a patient waiting on medication. Surfaced as "Expected <date>".
- Other columns map to `TotalCopay` (money due on delivery), `DelInstructions`,
  and the patient's `MobileNo`/ZIP. Staff actions: Get Undelivered, Edit Delivery
  Information, Add Orders Manually, **Finalize Orders**.

### Rx Refill Queue → `RXREFQUE` (confirmed from the UI, 2026-08-26)
The busiest lane: `RXREFQUE` holds exactly **1,140** rows, matching the Live
Workflow "Refill Queue" count and the `Rfq:1140` status-bar figure.
`RXREFQUEDEL` (78,585) is the processed/removed history.

Columns: `RXNO, DATE_QUED, TIME_QUED, PHARMACIST, SENTBYPROG, REFDUEDATE, REMARK,
VOICE, STATUS, INS, ID, Delivery, RefDueCalcMethod, ContextId, ExternalStatus,
PCSYNCH`. Queue spans 2025-06-03 → 2026-08-25 (items sit for a long time).

**`SENTBYPROG` is the request SOURCE** — it drives the screen's tabs:
`All | Pharmacist | IVR System | FillMyRefills.com | PrimeWeb-Refill Req. |
PrimeWeb-Discontinue Req.`

> 🔑 **Every row — 1,140 live and 78,585 historical — is `SENTBYPROG='PH'`
> (Pharmacist).** `ContextId`, `ExternalStatus` and `VOICE` are NULL on all of
> them. Medico has never used the IVR, FillMyRefills or PrimeWeb channels.

Two consequences, and they shape the whole staff-console question:

1. **Refills here are pharmacy-initiated, not patient-initiated.** Staff work
   proactively from refills-due (`Add (R)efs Due`, `Add Expired Refills`), rather
   than reacting to patient requests. So a patient-initiated refill is genuinely
   NEW inbound work with no existing home in their day — it is not simply a case
   of routing into a lane they already watch.
2. **PrimeRX does support external refill sources** (FillMyRefills.com is a
   third-party service, and `SENTBYPROG` + `ContextId`/`ExternalStatus` exist to
   carry them). We are read-only on MSSQL and must not write, but this is worth
   raising with the vendor: if there's a supported way to submit a refill request
   with our own source code, patient requests would land in the queue staff
   already work, instead of a second console they must remember to check.

The refill→prescriber loop is now fully mapped:
```
RXREFQUE (refill queue)  --"Send Refill Request"-->  EREQUEST MSGTYPE=REFREQ
   -> ERx Action List, TRANSSTAT='' (Awaiting Response)
   -> prescriber authorises -> NEW RXNO created (e.g. 5001272 -> 5002619)
   -> CLAIMS row -> fill -> delivery/pickup
```

### Delivery batches → `DELIVERY_BATCH` (confirmed from the UI, 2026-08-26)
Batch No. format `BN` + `YYMMDD` + sequence. 10,191 rows.
- `BatchStatus`: **`C` = Closed (10,129), `O` = Open (62)**. Unlike `DELIVERY_ORDER`,
  batches DO get closed properly — the screen filtered to Open shows the ~62
  stragglers, some abandoned since 2020.
- `BATCHTYPE`: **`H` = Individual/home (8,943), `F` = Facility (1,248)** — the screen
  renders these as INDIVIDUAL / FACILITY.
- Money is tracked per batch: `TotalCopay` vs `TotalCopayCollected`.
- `DelUserId` → `DELIVERY_USER`.

### `DELIVERY_USER` — driver lookup
Maps the delivery code to a person: `AM`→JASMIN, `GG`→ANI, `OR`→OZOD, `AR`→CARLOS,
`HN`→HAMID, `DRV`→STEVE, plus a non-person `MP`→MEDICO PHARMACY (excluded when
resolving). `DELIVERY_ORDER.DRIVER` holds the code, so patient-facing screens must
resolve it — we were showing a bare "AM".

> 🔒 **Security note (vendor system, not ours):** `DELIVERY_USER` stores driver
> passwords in **plaintext**, and they are nearly all `1234`. We only read this
> table for the name column. Worth raising with the PrimeRX vendor; nothing we can
> fix from our side.

### Return to Stock / unpicked Rxs (confirmed from the UI, 2026-08-26)
The operational screen behind "Rx(s) Ready" and "Unpicked Rxs Over 14 Days".
Filter is *"Only Rxs Unpicked for Over N Days"* + a fill-date range; every listed
row shows `B.St = B` (billed) and unpicked — **which is exactly how we derive
`ready_for_pickup`**, so our definition matches theirs in kind (if not in exact
window). Staff actions: Send Pickup Reminder · Print Return Label · Reverse Rx(s)
(reverse the insurance claim when stock goes back) · Remove Rx · File Rx.

Not readable from our side:
- `RxReturnToStockLog` has **1 row** and `Reminder` / `TaskReminderLogs` 1 each, so
  **"Send Pickup Reminder" leaves no usable trail** — we cannot tell whether a
  patient has already been reminded. Our "Ready for pickup" is therefore
  complementary, not duplicative, but we also can't coordinate with it.
- `RXNOTES` is empty; the screen's "Rx Notes" free text ("08/25 LM", "08/26 Deliv",
  "08/17 wait") lives elsewhere and was not located.

### `RefDueView` — the pharmacy's own refill-due dates (in use since 2026-08-26)
PrimeRX computes, per Rx, when a refill is due and how far ahead/behind the
patient is — the same numbers staff work from. We now read it rather than
deriving our own from `lastFilled + daysSupply`, so a patient and the counter
can't disagree about a date. It also accounts for quantity remaining and
pickup-based thresholds, which our derivation cannot.

- `Duedate` → the due date shown to the patient
- **`DaysRemaining` is SIGNED** — negative means already run out by that many days.
  Our own calculation clamps at zero, discarding the strongest adherence signal
  available ("ran out 34 days ago" ≠ "time to reorder").
- `QtyRemaining`, plus threshold/pickup-based variants we don't use yet.
- Supplementary: only tracked prescriptions appear (16 of our test patient's 22).
- Costs ~800ms — run it in parallel with the other per-patient queries.

⚠️ **Scope overdue to CURRENT medication only.** The view keeps tracking
superseded Rx numbers, so an old generation of a drug the patient still takes
under a newer Rx reports absurd values (-230, -192, -165 days for our test
patient). Unfiltered, we'd tell someone they ran out eight months ago of
something they collected last month. Filtered to current meds, the same patient
shows a truthful picture: 3 due today, 4 overdue by 34–62 days.

#### Refill eligibility — the rule set behind "WARNING! 10 Days Early For Refill" (decoded 2026-09-15)
Read from the view's definition (`sys.sql_modules`) and confirmed against the PrimeRX
**Refill Options** dialog for Rx 5001991 (Tamsulosin, 30-day supply, filled 8/26, dialog
on 9/15 said *10 Days Early*; `DaysRemaining` = 10 ✅).

Two verdict columns, both with the same vocabulary; **use `RefillStatusThreshold`** —
it's what the pharmacy acts on:

| Value | Meaning | Source rule |
|---|---|---|
| `OKTOREFILL ` (trailing space!) | fill it today | none of the below |
| `earlyforrefill` | too soon | `RefillStatus`: days since fill < `DAYS`. `RefillStatusThreshold`: days since fill < `CEILING(DAYS × REFDUEPERCENT/100)` |
| `NoQtyLeft` | all authorised qty consumed | `QTY_ORD × (refills+1) − consumed ≤ 0` |
| `Expired` | Rx expired | `RXINFO.RxExpires` or `DATEO + INSCAR.MDREFILL` days (365) |
| `Discontinued` | | `CLAIMS.ORDSTATUS = 'D'` |
| `Transfered` | | `STATUS = 'T'` and `ALLOWTRRXREF = 'N'` (off here → never emitted) |
| `ControlNotRefillable` | | CII: `CONSTANT.CLASS2REFD = -1` → never. CIII–CV: > `CLASS3/4/5REFD` days (180) since order |
| `FiledRx` | never dispensed | `STATUS = 'F'` |

Precedence is the table order (Filed → Discontinued → Transferred → NoQty → Expired →
early → controlled → OK).

**Store settings involved** (identical in both DBs):
- `DEF0001.REFDUEPERCENT = 83` → a 30-day supply is refillable from day 25 (`DuedateByThreshold`);
  the dialog's *N Days Early* is the raw `Duedate` (day 30). 26 Rx are currently early by the
  raw date but OK by threshold — staff fill those.
- `INSCAR.REFDUEPERCENT` — per-plan override; all NULL/0 at Medico.
- `CONSTANT.CLASS2REFD=-1, CLASS3/4/5REFD=180`.
- `INSCAR.MDREFILL=365` — Rx lifetime.

Columns worth reading: `Duedate`, `DuedateByThreshold`, `DaysRemaining`, `QtyRemaining`,
`ExpiryDate`, `IsExpired`, `RefillStatusThreshold`. The `*ByPickup` / `*Equi*` variants
re-run the same maths from the pickup date and across equivalent NDCs — not used.

**Portal use:** exposed as `refillEligibility` + `refillEligibleDate`; the API refuses
`refill_too_early` / `prescription_expired` / `prescription_discontinued` /
`controlled_not_refillable` so no request lands on the counter that PrimeRX itself would
refuse. Distribution today: 1,138 NoQtyLeft · 398 OK · 181 early · 113 Expired · 49 Discontinued.

#### Pharmacist-side refill flow (from the Refill Options dialog, 2026-09-15)
Refilling is NOT one click for staff. The dialog shows the early-refill warning and a
**"Rxs with Equivalent Drugs"** grid (other Rx numbers for the same drug — the superseded
generations we filter out of "current"), then on *Refill* PrimeRX prompts for a
**replacement/equivalent NDC** (substitution or stock) and raises **DUR alerts**
(`RXDUR` 2,725 rows / `RXDUR_Log`, `INTERACT` 224,849 — drug–drug interaction reference,
`WARNING` 358). These are clinical decisions and stay with the pharmacist — the portal does
not surface DUR content to patients; our queue only says *which* Rx the patient wants.

**"PREFERRED DRUGS AVAILABLE — would you like to replace?"** (decoded 2026-09-15). Not a
clinical substitution — a *purchasing* one. `DRUG.IsPreferred` marks the NDC the pharmacy
prefers to stock for a given product (`DRUG.TXRXCODE` groups equivalents, e.g.
`05701000040000` = tamsulosin 0.4mg cap). Rx 5001991 is on `65862059801` (Aurobindo,
100-ct); the preferred row is `65862059805` (same Aurobindo product, 500-ct package).
`DEF0001.AutoReplacePrefDrugOnRefill = 'P'` = **Prompt** on every refill (Y would swap
silently, N never asks); `preferredDrugOnEnterRx = 'Y'`, `ERXSelectPreferredDrug = 'Y'`.
Same molecule, strength, form and manufacturer — invisible to the patient except the NDC on
the label, so the portal's per-fill history may legitimately show the NDC change between fills.
`DRUG.QNTHAND` is 0 on every equivalent NDC: PrimeRX inventory counts are NOT maintained here,
so "on hand" can't drive any portal feature.

### What actually happens when an Rx is queued for refill (read-only investigation, 2026-08-26)

**No triggers exist on `RXREFQUE`**, so queuing does not silently cascade. (`CLAIMS`
by contrast carries 13 triggers — bucket inventory, `TRG_Claims_WF_Transition_UPD`
for workflow transitions, ERx fill-indicator maintenance — but those fire on fills,
not on queueing.)

Ten procedures reference `RXREFQUE`. The three that write it:

| Procedure | Writes | Stamps `SENTBYPROG` |
|---|---|---|
| `usp_SaveRxRefQueRefill` | `RXREFQUE` only (reads `CLAIMS` + `RefDueView`) | `OB` |
| `usp_SaveRefillRequest` | `RXREFQUE` + `FMRPatRxRequest` | `FR` |
| `usp_ProcessCallResponse` (IVR) | `RXREFQUE` + `RefillAuthActivityLog` + `MessagingQueueHistory` | — |

`usp_SaveRxRefQueRefill` is the minimal path: it upserts one row per RXNO (dedupe
by RXNO — the same shape as our own `command_queue` dedupe), pulling `REFDUEDATE`
straight from `RefDueView` and `INS` from the latest `CLAIMS` row. Nothing else is
touched.

**Who queues:** every one of the 1,140 live rows has `PHARMACIST='MMS'` and
`SENTBYPROG='PH'` — a system account, not named staff. Combined with the screen's
`Add (R)efs Due` / `Add Expired Refills` buttons, the queue is bulk-populated from
refills-due and then worked, rather than hand-added per prescription.

> 🔑 **`usp_SaveRefillRequest` is a vendor-provided intake for external refill
> requests** — effectively a patient-portal API. Its 25 parameters are exactly what
> a portal holds:
> `NPINO, FName, LName, DOB, Phone, Mobile, Email, CallBackNo, DeliveryMethod,
> PickUpDate, PickUpTime, RefillConfirmation, RefillReminder, UserStatus,
> AddressLine1, AddressLine2, City, State, Zip, SentBy, ContextId, RxListTABLE,
> PatientNo, ExternalStatus, Remark`
>
> Note `SentBy` (our own source code), `ContextId`/`ExternalStatus` (the
> external-system hooks that sit NULL in `RXREFQUE`), `RxListTABLE` (a table-valued
> list of prescriptions), and full delivery preferences. `FMRPatRxRequest` — the
> companion request log — exists with the matching columns and is **empty (0 rows)**
> at Medico, i.e. the channel is wired but unused here.
>
> This is the supported path we hypothesised. Calling a vendor procedure is a
> different proposition from writing tables directly, but it is still a write to
> MSSQL: **confirm with the PrimeRX vendor before using it.** If blessed, patient
> refill requests would land in the Refill Queue staff already work, tagged with our
> own source, instead of a separate console.
