# London Ambulance Dispatch — Phase 2: Real NHS Wait-Time Data

## Context
Phase 1 (shipped, commit `7f84a7d`) routes an ambulance from an accident site to the nearest hospital by straight-line distance, drawing the real road route via OSRM. It works, but every hospital is treated as equally good — arrival at the door is treated as the end of the story.

The real goal is to show that **the nearest ER is often the wrong ER**, because ERs near accident hotspots are the ones running hot. Phase 2 brings in real NHS data so the app can answer: *if I crashed at this place, on this date and time, how long until I'm actually seen?* — and surface the case that a slightly-further, less-crowded department gets the patient treated sooner.

Research confirmed what is and isn't obtainable, which shapes this whole phase (see **Data reality** below). Per-patient hourly waits are not public; the wait figure must be **modelled from real inputs and labelled as such**.

## Data reality (researched, confirmed)

**Real and directly downloadable, no auth:**
- **NHS England monthly A&E, per-trust** — CSV, one file per month, 2015→present.
  Confirmed schema: `Period, Org Code, Parent Org, Org name, A&E attendances Type 1, Type 2, Other A&E Department, …, Attendances over 4hrs (per type), Emergency admissions, …`
  Example: `https://www.england.nhs.uk/statistics/wp-content/uploads/sites/2/2026/05/Monthly-AE-March-2026-revised-flkg42.csv`
  Index page listing every month's file: `https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/`
- **Hospital A&E Activity (annual, NHS Digital)** — provider-level CSV with **arrival distributions by hour of day and day of week**.
  `https://digital.nhs.uk/data-and-information/publications/statistical/hospital-accident--emergency-activity/2024-25`

**Not obtainable:** per-patient, per-hour actual waits (ECDS patient-level, DARS application required). Therefore the "time to be seen" number is a **model**, not a measurement.

**Known risk:** `digital.nhs.uk` returned HTTP 403 to automated fetch during research. If the provider-level arrival CSV can't be retrieved, fall back to the **national** arrival-by-hour curve applied to all trusts, labelled as a national-average shape rather than trust-specific. Do not silently substitute — the UI must say which one is in use.

## Correctness bug this fixes
Phase 1 treats all 23 entries in `hospitals.json` as equivalent "A&E". They are not. In testing, Elephant & Castle routed to **Guy's Hospital** — which runs an Urgent Care Centre, not a Type 1 major A&E. St Thomas' (1.40 km, barely further) is the Type 1. **A serious trauma routed to Guy's is a wrong dispatch.** Adding the NHS Type 1/2/3 classification fixes the routing, not just the display.

## Framing correction (important for the pitch)
The instinct is "minor injuries are clogging the ER," measured via Type 3. That reading is backwards: **Type 3 = minor injury units, UTCs and walk-in centres — separate facilities that exist to divert minor injuries away from major A&E.** High Type 3 near a hotspot is evidence of diversion working.

The defensible, data-supported claim is measured on **Type 1**: attendance volume and 4-hour breach rate at major A&E departments near hotspots. Build the argument on that.

## Approach

Stay static — no backend. Fetch and parse NHS data **once at build time** via a small Node script, commit the trimmed result as JSON. The app keeps loading local JSON, as it does today.

### 1. Data pipeline (`scripts/fetch-nhs-data.mjs`, run manually, not at page load)
- Download the last 12 monthly CSVs from NHS England.
- Filter to London A&E providers only; keep Org Code, Org name, period, Type 1/2/3 attendances, over-4hr counts per type, emergency admissions.
- Derive per-trust per-month: Type 1 attendances, Type 1 4-hour breach rate, total attendances.
- Fetch the annual arrival-by-hour / day-of-week distribution; normalise to a 24×7 relative-demand matrix. Record whether it resolved provider-level or national-fallback.
- Emit `data/nhs-trusts.json` (12 months per trust) and `data/arrival-curve.json` (24×7 matrix + a `source` field: `"provider"` or `"national-average"`).

### 2. Link hospitals to trusts (`hospitals.json`)
Add to each entry: `orgCode` (NHS trust code, e.g. `RJ1` for Guy's and St Thomas'), and `aeType` (`1` or `3`).
**Caveat to encode:** NHS monthly data is **trust**-level, and one trust runs multiple hospitals (RJ1 = both Guy's *and* St Thomas'). Wait figures are therefore per-trust and shared across that trust's sites — state this in the UI, don't imply per-building precision.

### 3. Nearest-hospital logic (`app.js`, extend `rankHospitals`)
- Filter to `aeType === 1` for the primary dispatch target — a real ambulance with a trauma goes to a major A&E.
- Keep the existing haversine ranking within that filtered set.

### 4. Wait model (`app.js`, new `estimateWait`)
Inputs, all real: trust's Type 1 4-hour breach rate for the selected month; that trust's relative demand at the selected hour/weekday from the arrival curve.
Output: an estimated "time to be seen" band (e.g. "2h 15m – 3h 30m"), not a false-precision single number.
Keep the formula in one function with a comment stating the assumptions plainly, so it can be defended or swapped.

### 5. UI (`index.html`, `style.css`, `app.js`)
- Add date + time-of-day pickers to the panel (default: most recent month in the data).
- Dispatch panel gains: drive ETA (real, OSRM) → estimated wait to be seen (modelled) → **total time to treatment**.
- **Labelling — every number carries provenance.** Measured NHS figures and OSRM drive times render in the normal style; modelled numbers get a distinct visual badge (e.g. `~` prefix + muted "modelled" tag) and a methodology note stating inputs, the DARS limitation, and trust-vs-hospital granularity.
- **The payoff:** where a further hospital has a lower total time to treatment, show it as a callout — *"Nearest: St Thomas', 6 min drive, ~3h 10m to treatment. Better: King's, 11 min drive, ~1h 40m to treatment."* This is the whole thesis in one line.

## Files
- `scripts/fetch-nhs-data.mjs` — new, build-time fetch/parse
- `data/nhs-trusts.json`, `data/arrival-curve.json` — new, generated + committed
- `hospitals.json` — add `orgCode`, `aeType`
- `app.js` — extend `rankHospitals`; add `estimateWait`, date/time state; extend `renderResults`
- `index.html`, `style.css` — date/time controls, modelled-value badge styling, methodology note

## Verification
- Run the fetch script; confirm `data/nhs-trusts.json` has 12 months for each London trust and values match a spot-check against the NHS CSV opened directly.
- Confirm `arrival-curve.json` records its true `source`, and the UI reflects national-fallback if that's what happened.
- Serve over http:// and confirm: Elephant & Castle now routes to **St Thomas' (Type 1), not Guy's** — the bug fix.
- Change hour from 04:00 to 20:00 on the same site; estimated wait should rise with the real arrival curve.
- Find and confirm at least one accident site where a further hospital wins on total time to treatment.
- Confirm every modelled number is visually badged and no measured number is.
