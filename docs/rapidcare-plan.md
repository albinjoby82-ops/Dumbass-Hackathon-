# RapidCare — Best-Destination Recommendation Engine

## Context
The current app (live at `albinjoby82-ops.github.io/Dumbass-Hackathon-`) answers one narrow question: of the nearest major A&Es, which gets the patient treated soonest? It treats every patient as clinically identical, which is its central weakness — a stroke patient and a broken wrist get the same answer.

RapidCare replaces it with the real product: a **clinical capability × patient condition × travel time × operational capacity** engine. A dispatcher enters what is wrong with the patient, and the system ranks destinations by whether the hospital can actually treat that condition, how long it takes to get there, and how loaded it currently is.

Scope for this build is the **recommendation engine** — not case management, case IDs, status machine, or hospital comms. Those come later; the engine is the thing everything else hangs off.

## The insight that shapes the data model
Clinical designations in London are **real, published NHS pathway design** — not something we invent:
- **4 adult Major Trauma Centres**: Royal London, King's, St Mary's, St George's
- **8 Hyper-Acute Stroke Units** (King's runs two of them)
- **~8 Heart Attack Centres** (24/7 PPCI)

Critically: **a specialist centre is not necessarily an A&E.** Barts Heart Centre and Harefield take STEMI patients directly, bypassing A&E. So the candidate destination set is a *function of the condition*, not one fixed hospital list. `hospitals.json` must therefore grow beyond Type 1 A&Es to include specialist centres.

This also means bypassing a nearer hospital is not our invention — it is existing LAS practice for trauma, stroke and STEMI. We are systematising something clinically accepted.

## What is real vs simulated (must stay visible in the UI)
**Real:** clinical designations (each cited), travel times (OSRM), ED crowding baseline (NHS breach rates already in `data/nhs-trusts.json`), hospital coordinates.

**Simulated, and labelled as such:** live ED capacity, ambulance queue depth, divert status. No public real-time feed exists. There are no camera feeds and no ambulance GPS feed — the CV/live-capacity parts of the spec are stubbed behind an interface a real feed could later fill.

**Rule: never state an unverified clinical designation as fact.** Every capability entry carries a `source` URL and `verified` flag; unverified entries render visibly differently and must be confirmed before demoing.

## Approach

### 1. Capability data (`data/hospital-capabilities.json`) — new
Per site: capability tags with citation.
Tags: `MTC`, `HASU`, `PPCI`, `PAEDS_MAJOR`, `NEUROSURGERY`, `TYPE1_ED`, `BURNS`.
```
{ "site": "Royal London Hospital", "tags": ["MTC","HASU","TYPE1_ED","NEUROSURGERY"],
  "sources": { "MTC": "https://…", "HASU": "https://…" }, "verified": true }
```
Build step: verify each designation against an NHS/trust source and cite it. Anything unconfirmed ships `verified: false`.

### 2. Extend `hospitals.json`
Add non-A&E specialist centres (Barts Heart Centre, Harefield) with `aeType: null`, so they are reachable for STEMI but never offered as general ED destinations.

### 3. Clinical requirement profile (`src/clinical.js`) — new, pure
Maps structured dispatcher input → required capability tags + time-criticality weight.
Inputs: symptoms/injury, severity, consciousness, breathing, major bleeding, suspected stroke, suspected cardiac, trauma, age group.
Rules (each commented with its pathway rationale):
- suspected stroke → `HASU` required, high time-criticality
- suspected STEMI → `PPCI` required, high time-criticality
- major trauma (mechanism/severity) → `MTC` required, high
- paediatric + major → `PAEDS_MAJOR`
- unconscious / airway compromise → `TYPE1_ED`, highest travel weight
- otherwise → `TYPE1_ED`, capacity weighted more heavily than travel

### 4. Capacity layer (`src/capacity.js`) — new
- Simulated ED state per trust, **seeded from the real NHS breach rate** already committed, so the baseline is grounded.
- State: `queueDepth`, `ambulancesWaiting`, `divertStatus`.
- Manual override per hospital (declare pressure / divert), broadcast via `BroadcastChannel` + `localStorage` so a future hospital console syncs with no backend.
- Reuse the existing `estimateWait` lognormal model from `app.js` for the historical baseline.

### 5. Ranking engine (`src/engine.js`) — new, pure and testable
1. Build requirement profile.
2. **Hard gate**: candidates must hold every required tag. If none qualify, fall back to nearest `TYPE1_ED` and surface an explicit warning — never silently drop a clinical requirement.
3. One OSRM `table` request for travel times across candidates (reuse `fetchDurations` from `app.js`).
4. Score = weighted(clinical suitability, travel, capacity penalty); weights come from time-criticality.
5. Return ranked list **with a per-hospital explanation** — dispatchers must see *why*, not just a number.

Keep scoring weights in one exported constant so they can be defended or tuned.

### 6. UI (`index.html`, `app.js`, `style.css`) — replaces current router
- Left: condition intake form (structured fields above) + location (map click, manual entry, optional browser geolocation — never assume GPS).
- Centre: map with patient, candidates, route to top recommendation.
- Right: ranked destinations, each showing required capability met, travel time, capacity state, and the explanation.
- Capacity override panel.
- Provenance badges carried over from the current build: measured plain, modelled `~` badged, simulated clearly marked.

## Files
- `data/hospital-capabilities.json`, `src/clinical.js`, `src/capacity.js`, `src/engine.js` — new
- `hospitals.json` — add specialist centres + capability linkage
- `index.html`, `app.js`, `style.css` — rebuilt as the RapidCare dispatcher view
- Reuse from current `app.js`: `haversineKm`, `fetchDurations`, `fetchRoute`, `estimateWait`, `normInv`, `formatMins`, provenance badge CSS

## Verification
Serve over http:// and confirm each scenario, since these are the claims the demo rests on:
- **Suspected stroke at Elephant & Castle** → ranks a HASU first, not the nearest A&E; explanation names the stroke pathway.
- **Suspected STEMI** → ranks a heart attack centre, including a non-A&E site, and never offers a plain Type 1 with no PPCI.
- **Major trauma** → ranks one of the four MTCs; nearer non-MTC hospitals excluded with a stated reason.
- **Minor injury** → falls back to nearest Type 1, capacity-weighted (should reproduce current app behaviour).
- **Impossible requirement** → fallback warning fires rather than silently returning a hospital that cannot treat the patient.
- Set a top-ranked hospital to divert → ranking visibly changes and the reason updates.
- Confirm no `verified: false` designation renders as if confirmed.
- Re-check provenance: no simulated capacity value styled as measured.
