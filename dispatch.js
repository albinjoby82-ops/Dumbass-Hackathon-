/* Driver dispatch UI — severity + injury type -> ranked hospital list -> directions.
 *
 * The incident normally arrives preloaded from the dispatcher console (src/incidents.js):
 * the crew is already on scene, so location, severity and condition are filled in and the
 * crew's job is to confirm or correct them from what they can actually see. Everything
 * stays editable, and every change is reported back to the dispatcher.
 */

import { IncidentChannel } from "./src/incidents.js";
import { AlertService } from "./src/alerts.js";

const LONDON_CENTER = [51.5074, -0.1278];
const OSRM_BASE = "https://router.project-osrm.org";
const CANDIDATE_POOL = 6;

const INJURY_TYPES = [
  { value: "trauma", label: "Major trauma", desc: "Multi-system / severe mechanism", service: "MTC" },
  { value: "stroke", label: "Suspected stroke", desc: "FAST positive", service: "HASU" },
  { value: "cardiac", label: "Chest pain / cardiac", desc: "Suspected heart attack", service: "HAC" },
  { value: "head", label: "Head injury", desc: "Neuro emergency", service: "NEURO" },
  { value: "burns", label: "Severe burns", desc: "", service: "BURNS" },
  { value: "medical", label: "Medical emergency", desc: "Breathing, seizure, etc.", service: null },
  { value: "other", label: "Other / general injury", desc: "", service: null },
];

const SEVERITIES = [
  { value: "critical", label: "Critical", desc: "Immediately life-threatening", mode: "fastest", color: "#ff4d4d" },
  { value: "serious", label: "Serious", desc: "Urgent, potentially life-threatening", mode: "fastest", color: "#ff9d42" },
  { value: "moderate", label: "Moderate", desc: "Needs urgent care, stable", mode: "total", color: "#ffd479" },
  { value: "minor", label: "Minor", desc: "Stable, non-life-threatening", mode: "total", color: "#6fe3a5" },
];

const state = {
  hospitals: [],
  hotspots: [],
  nhs: null,
  curve: null,
  accident: null,
  severity: null,
  injuryType: null,
  ranked: [],
  chosen: null,
  incident: null,   // the job as dispatched
  asDispatched: null, // snapshot used to work out what the crew changed
};

const incidents = new IncidentChannel();

const alerts = new AlertService();

const map = L.map("map").setView(LONDON_CENTER, 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const hospitalLayer = L.layerGroup().addTo(map);
const hotspotLayer = L.layerGroup().addTo(map);
const dispatchLayer = L.layerGroup().addTo(map);

function dotIcon(color, size) {
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function emojiIcon(emoji, size) {
  return L.divIcon({
    html: `<div style="font-size:${size}px; line-height:1; transform: translate(-50%, -50%);">${emoji}</div>`,
    className: "",
    iconSize: [0, 0],
  });
}

/* ---------------- geometry ---------------- */

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- wait model (ported from the phase-2 nearest-vs-fastest model) ---------------- */

function normInv(p) {
  if (p <= 0 || p >= 1) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const SIGMA = 0.8;

function estimateWait(orgCode, monthKey, day, hour) {
  const trust = state.nhs?.trusts?.[orgCode];
  const month = trust?.months?.[monthKey];
  if (!month || month.type1BreachRate == null) return null;

  const demand = state.curve?.matrix?.[day]?.[hour] ?? 1;
  const breach = month.type1BreachRate;
  const effective = Math.min(0.95, Math.max(0.01, breach * demand));
  const medianHours = 4 * Math.exp(-SIGMA * normInv(1 - effective));
  const spread = 0.6745 * SIGMA;

  return {
    trustName: trust.name,
    breachRate: breach,
    medianMin: Math.round(medianHours * 60),
    rangeMin: [
      Math.round(medianHours * Math.exp(-spread) * 60),
      Math.round(medianHours * Math.exp(spread) * 60)
    ],
  };
}

function latestPeriodKey() {
  const periods = state.nhs?.periods || [];
  return periods.length ? periods[periods.length - 1].key : null;
}

/* ---------------- ranking ---------------- */

async function fetchDurations(accident, targets) {
  const coords = [accident, ...targets].map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM_BASE}/table/v1/driving/${coords}?sources=0&annotations=duration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error("No drive times available");
  return data.durations[0].slice(1);
}

async function fetchRoute(from, to) {
  const url = `${OSRM_BASE}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) throw new Error("No drivable route found");
  return data.routes[0];
}

async function rankHospitals(accident, injuryType, severity) {
  const injury = INJURY_TYPES.find((i) => i.value === injuryType);
  const sev = SEVERITIES.find((s) => s.value === severity);
  const requiredService = injury?.service || null;

  let pool = state.hospitals.filter((h) => h.aeType === 1 && (!requiredService || (h.services || []).includes(requiredService)));
  let fallback = false;
  if (requiredService && pool.length === 0) {
    pool = state.hospitals.filter((h) => h.aeType === 1);
    fallback = true;
  }

  const candidates = pool
    .map((h) => ({ ...h, straightKm: haversineKm(accident, h) }))
    .sort((a, b) => a.straightKm - b.straightKm)
    .slice(0, CANDIDATE_POOL);

  const durations = await fetchDurations(accident, candidates);
  const periodKey = latestPeriodKey();
  const now = new Date();

  candidates.forEach((h, i) => {
    h.driveMin = durations[i] / 60;
    if (sev.mode === "total" && periodKey) {
      h.wait = estimateWait(h.orgCode, periodKey, now.getDay(), now.getHours());
      h.totalMin = h.wait ? h.driveMin + h.wait.medianMin : h.driveMin;
    } else {
      h.wait = null;
      h.totalMin = h.driveMin;
    }
  });

  candidates.sort((a, b) => a.totalMin - b.totalMin);

  return { candidates, requiredService, fallback, mode: sev.mode };
}

/* ---------------- formatting ---------------- */

function formatMins(mins) {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function stepInstruction(step) {
  const m = step.maneuver;
  const road = step.name && step.name.length ? ` onto ${step.name}` : "";
  const typeMap = {
    depart: "Head out",
    arrive: "Arrive at destination",
    turn: `Turn ${m.modifier || ""}`.trim(),
    "new name": "Continue",
    merge: `Merge ${m.modifier || ""}`.trim(),
    roundabout: `Take the roundabout${m.exit ? `, exit ${m.exit}` : ""}`,
    rotary: `Take the roundabout${m.exit ? `, exit ${m.exit}` : ""}`,
    fork: `Keep ${m.modifier || ""}`.trim(),
    "end of road": `Turn ${m.modifier || ""}`.trim(),
    continue: `Continue ${m.modifier || ""}`.trim(),
  };
  return `${typeMap[m.type] || m.type}${road}`;
}

/* ---------------- UI wiring ---------------- */

const els = {
  accidentStatus: document.getElementById("accidentStatus"),
  hotspotList: document.getElementById("hotspotList"),
  severityGrid: document.getElementById("severityGrid"),
  injuryGrid: document.getElementById("injuryGrid"),
  rankSection: document.getElementById("rankSection"),
  rankList: document.getElementById("rankList"),
  rankNote: document.getElementById("rankNote"),
  newIncidentBtn: document.getElementById("newIncidentBtn"),
  locateBtn: document.getElementById("locateBtn"),
  confirmSection: document.getElementById("confirmSection"),
  confirmLocation: document.getElementById("confirmLocation"),
  confirmSeverity: document.getElementById("confirmSeverity"),
  confirmInjury: document.getElementById("confirmInjury"),
  confirmBtn: document.getElementById("confirmBtn"),
  editDetailsBtn: document.getElementById("editDetailsBtn"),
  incidentSection: document.getElementById("incidentSection"),
  incidentRef: document.getElementById("incidentRef"),
  incidentTag: document.getElementById("incidentTag"),
  incidentPathway: document.getElementById("incidentPathway"),
  incidentScene: document.getElementById("incidentScene"),
  incidentRead: document.getElementById("incidentRead"),
  incidentRec: document.getElementById("incidentRec"),
  incidentNotes: document.getElementById("incidentNotes"),
  incidentAmend: document.getElementById("incidentAmend"),
  incidentAmendList: document.getElementById("incidentAmendList"),
  incomingBanner: document.getElementById("incomingBanner"),
  incomingText: document.getElementById("incomingText"),
  incomingLoadBtn: document.getElementById("incomingLoadBtn"),
  navOverlay: document.getElementById("navOverlay"),
  navIcon: document.getElementById("navIcon"),
  navDistance: document.getElementById("navDistance"),
  navText: document.getElementById("navText"),
  navEndBtn: document.getElementById("navEndBtn"),
  navProgressFill: document.getElementById("navProgressFill"),
  navHospitalName: document.getElementById("navHospitalName"),
  navRemainingTime: document.getElementById("navRemainingTime"),
  navRemainingDist: document.getElementById("navRemainingDist"),
  navEtaClock: document.getElementById("navEtaClock"),
  navArrived: document.getElementById("navArrived"),
  navArrivedHospital: document.getElementById("navArrivedHospital"),
  navArrivedWait: document.getElementById("navArrivedWait"),
  navArrivedCloseBtn: document.getElementById("navArrivedCloseBtn"),
};

function renderSeverityGrid() {
  els.severityGrid.innerHTML = "";
  SEVERITIES.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.dataset.value = s.value;
    btn.style.setProperty("--accent-color", s.color);
    btn.innerHTML = `<span class="choice-label">${s.label}</span><span class="choice-desc">${s.desc}</span>`;
    btn.addEventListener("click", () => selectSeverity(s.value));
    els.severityGrid.appendChild(btn);
  });
}

function renderInjuryGrid() {
  els.injuryGrid.innerHTML = "";
  INJURY_TYPES.forEach((i) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.dataset.value = i.value;
    btn.innerHTML = `<span class="choice-label">${i.label}</span><span class="choice-desc">${i.desc}</span>`;
    btn.addEventListener("click", () => selectInjury(i.value));
    els.injuryGrid.appendChild(btn);
  });
}

function highlight(gridId, value) {
  document.querySelectorAll(`#${gridId} .choice-btn`).forEach((b) =>
    b.classList.toggle("active", b.dataset.value === value)
  );
}

function selectSeverity(value) {
  state.severity = value;
  highlight("severityGrid", value);
  updateConfirmSummary();
  renderAmendments();
}

function selectInjury(value) {
  state.injuryType = value;
  highlight("injuryGrid", value);
  updateConfirmSummary();
  renderAmendments();
}

function renderHotspotList() {
  els.hotspotList.innerHTML = "";
  state.hotspots.forEach((spot) => {
    const btn = document.createElement("button");
    btn.className = "hotspot-btn";
    btn.textContent = spot.name;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".hotspot-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setAccident(spot.lat, spot.lng, spot.name);
      map.setView([spot.lat, spot.lng], 14);
    });
    els.hotspotList.appendChild(btn);
  });
}

function setAccident(lat, lng, label) {
  state.accident = { lat, lng, label };
  dispatchLayer.clearLayers();
  L.marker([lat, lng], { icon: emojiIcon("🚧", 28) }).addTo(dispatchLayer).bindTooltip(label || "Accident scene");
  els.accidentStatus.textContent = label ? `${label} (${lat.toFixed(4)}, ${lng.toFixed(4)})` : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  resetDownstream();
  updateConfirmSummary();
  renderAmendments();
}

function resetDownstream() {
  state.ranked = [];
  state.chosen = null;
  els.confirmSection.hidden = true;
  els.rankSection.hidden = true;
  endNavigation();
}

function updateConfirmSummary() {
  if (!state.accident || !state.severity || !state.injuryType) return;

  // Any change to location/severity/injury invalidates a ranking already shown.
  els.rankSection.hidden = true;

  const sev = SEVERITIES.find((s) => s.value === state.severity);
  const injury = INJURY_TYPES.find((i) => i.value === state.injuryType);

  els.confirmLocation.textContent = state.accident.label
    ? `${state.accident.label} (${state.accident.lat.toFixed(4)}, ${state.accident.lng.toFixed(4)})`
    : `${state.accident.lat.toFixed(4)}, ${state.accident.lng.toFixed(4)}`;
  els.confirmSeverity.textContent = sev.label;
  els.confirmInjury.textContent = injury.label;

  els.confirmSection.hidden = false;
}

/* ---------------- incident hand-off from the dispatcher ---------------- */

const sevLabel = (v) => SEVERITIES.find((s) => s.value === v)?.label ?? v;
const injuryLabel = (v) => INJURY_TYPES.find((i) => i.value === v)?.label ?? v;

function locationLabel(loc) {
  if (!loc) return "—";
  return loc.label
    ? `${loc.label} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`
    : `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
}

/** Load a dispatched job into the form. The crew is assumed to be on scene already. */
function applyIncident(inc) {
  state.incident = inc;
  state.asDispatched = {
    location: { ...inc.location },
    severity: inc.severity,
    injuryType: inc.injuryType,
  };

  setAccident(inc.location.lat, inc.location.lng, inc.location.label);
  selectSeverity(inc.severity);
  selectInjury(inc.injuryType);
  map.setView([inc.location.lat, inc.location.lng], 14);

  els.incidentRef.textContent = inc.caseRef;
  els.incidentTag.textContent = inc.status === "dispatched" ? "Preloaded from dispatch" : "In progress";
  els.incidentPathway.textContent = inc.pathway || "";
  els.incidentScene.textContent = locationLabel(inc.location);
  els.incidentRead.textContent = `${sevLabel(inc.severity)} · ${injuryLabel(inc.injuryType)}`;
  els.incidentRec.textContent = inc.recommendation
    ? `${inc.recommendation.name} (${inc.recommendation.etaText})`
    : "—";
  els.incidentNotes.innerHTML = (inc.conditionNotes || []).map((n) => `<li>${n}</li>`).join("");
  els.incidentSection.hidden = false;
  els.incomingBanner.hidden = true;

  renderAmendments();
}

/** What the crew changed against what was dispatched — shown here and sent back. */
function computeAmendments() {
  const base = state.asDispatched;
  if (!base || !state.accident) return [];
  const out = [];

  const moved = haversineKm(base.location, state.accident) > 0.03;
  if (moved) out.push(`Scene: ${locationLabel(base.location)} → ${locationLabel(state.accident)}`);
  if (state.severity && state.severity !== base.severity)
    out.push(`Severity: ${sevLabel(base.severity)} → ${sevLabel(state.severity)}`);
  if (state.injuryType && state.injuryType !== base.injuryType)
    out.push(`Condition: ${injuryLabel(base.injuryType)} → ${injuryLabel(state.injuryType)}`);

  return out;
}

function renderAmendments() {
  if (!state.incident) return;
  const changes = computeAmendments();
  els.incidentAmend.hidden = changes.length === 0;
  els.incidentAmendList.innerHTML = changes.map((c) => `<li>${c}</li>`).join("");
  els.incidentTag.textContent = changes.length ? "Amended on scene" : "Preloaded from dispatch";
  els.incidentTag.classList.toggle("amended", changes.length > 0);
}

/** Push the crew's assessment back to the dispatcher. */
function reportAssessment() {
  if (!state.incident) return;
  const amendments = computeAmendments();
  const updated = incidents.amend(state.incident.caseRef, {
    location: { ...state.accident },
    severity: state.severity,
    injuryType: state.injuryType,
    amendments,
  });
  if (updated) state.incident = updated;
}

/** A job arriving while this console is open. */
function watchIncoming(list) {
  const open = list.find((i) => ["dispatched", "on-scene", "en-route", "arrived"].includes(i.status));
  if (!open) return;

  if (state.incident && open.caseRef === state.incident.caseRef) {
    state.incident = open;
    return;
  }
  // Nothing in hand yet — take it straight away. Mid-job, offer it instead of hijacking.
  if (!state.incident && !state.accident) {
    applyIncident(open);
    return;
  }
  if (!state.incident || open.caseRef !== state.incident.caseRef) {
    els.incomingText.textContent = `New incident ${open.caseRef} — ${open.pathway || "from dispatch"}`;
    els.incomingBanner.hidden = false;
    els.incomingLoadBtn.onclick = () => applyIncident(open);
  }
}

els.confirmBtn.addEventListener("click", runRanking);
els.editDetailsBtn.addEventListener("click", () => {
  els.rankSection.hidden = true;
  els.confirmSection.hidden = false;
});

async function runRanking() {
  if (!state.accident || !state.severity || !state.injuryType) return;
  reportAssessment();
  els.confirmSection.hidden = true;
  els.rankSection.hidden = false;
  els.rankList.innerHTML = '<li class="hint">Calculating drive times…</li>';

  try {
    const { candidates, requiredService, fallback, mode } = await rankHospitals(state.accident, state.injuryType, state.severity);
    state.ranked = candidates;

    els.rankNote.textContent = fallback
      ? `No tagged ${requiredService} unit found nearby — showing nearest major A&E departments. Specialist transfer may be required after initial assessment.`
      : mode === "fastest"
        ? "Ranked by drive time to a capable centre — treatment isn't gated by A&E queue at this severity."
        : "Ranked by modelled total time to treatment (drive time + estimated A&E wait).";

    els.rankList.innerHTML = "";
    candidates.forEach((h, idx) => {
      const li = document.createElement("li");
      li.className = "rank-card";
      const badge = requiredService && !fallback ? `<span class="service-badge">${requiredService}</span>` : "";
      const waitHtml = h.wait
        ? `<span class="rank-wait">~${formatMins(h.wait.rangeMin[0])}–${formatMins(h.wait.rangeMin[1])} modelled wait</span>`
        : mode === "total"
          ? `<span class="rank-wait muted">no NHS data</span>`
          : "";
      li.innerHTML = `
        <div class="rank-top">
          <span class="rank-num">${idx + 1}</span>
          <span class="rank-name">${h.name}</span>
          ${badge}
        </div>
        <div class="rank-metrics">
          <span class="rank-drive">${formatMins(h.driveMin)} normal drive</span>
          <span class="rank-dist">${h.straightKm.toFixed(1)} km</span>
          ${waitHtml}
        </div>
        <button class="select-btn" type="button">Select &amp; navigate</button>
      `;
      li.querySelector(".select-btn").addEventListener("click", () => chooseHospital(h));
      els.rankList.appendChild(li);
    });
  } catch (err) {
    els.rankList.innerHTML = `<li class="hint">Routing unavailable: ${err.message}</li>`;
    console.error(err);
  }
}

async function chooseHospital(hospital) {
  state.chosen = hospital;
  els.rankList.innerHTML = '<li class="hint">Calculating route…</li>';

  dispatchLayer.clearLayers();
  L.marker([state.accident.lat, state.accident.lng], { icon: emojiIcon("🚧", 28) }).addTo(dispatchLayer);
  L.marker([hospital.lat, hospital.lng], { icon: emojiIcon("🏥", 30) }).addTo(dispatchLayer).bindTooltip(hospital.name);

  try {
    const route = await fetchRoute(state.accident, hospital);
    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color: "#1b2a3a", weight: 8, opacity: 0.3 }).addTo(dispatchLayer);
    L.polyline(latlngs, { color: "#3aa0ff", weight: 4, opacity: 0.95 }).addTo(dispatchLayer);
    startNavigation(hospital, route, latlngs);
  } catch (err) {
    els.rankList.innerHTML = `<li class="hint">Route unavailable: ${err.message}</li>`;
    console.error(err);
  }
}

els.newIncidentBtn.addEventListener("click", () => {
  state.accident = null;
  state.severity = null;
  state.injuryType = null;
  document.querySelectorAll(".choice-btn.active, .hotspot-btn.active").forEach((b) => b.classList.remove("active"));
  els.accidentStatus.textContent = "Not set";
  resetDownstream();
  dispatchLayer.clearLayers();
});

/* ---------------- Google-Maps-style navigation view (simulated drive-through) ---------------- */

const MANEUVER_ICONS = {
  depart: "↑",
  arrive: "🏁",
  roundabout: "↻",
  rotary: "↻",
  merge: "↗",
};
function maneuverIcon(step) {
  const m = step.maneuver;
  if (MANEUVER_ICONS[m.type]) return MANEUVER_ICONS[m.type];
  const mod = m.modifier || "";
  if (mod.includes("left")) return mod.includes("sharp") ? "↰" : mod.includes("slight") ? "↖" : "←";
  if (mod.includes("right")) return mod.includes("sharp") ? "↱" : mod.includes("slight") ? "↗" : "→";
  if (mod === "uturn") return "↶";
  return "↑";
}

function buildCoordCumDistances(latlngs) {
  const cum = [0];
  for (let i = 1; i < latlngs.length; i++) {
    const a = { lat: latlngs[i - 1][0], lng: latlngs[i - 1][1] };
    const b = { lat: latlngs[i][0], lng: latlngs[i][1] };
    cum.push(cum[i - 1] + haversineKm(a, b));
  }
  return cum;
}

function pointAtDistance(latlngs, cum, targetKm) {
  const total = cum[cum.length - 1];
  const t = Math.max(0, Math.min(targetKm, total));
  let i = 1;
  while (i < cum.length && cum[i] < t) i++;
  if (i >= cum.length) return latlngs[latlngs.length - 1];
  const segStart = cum[i - 1];
  const segEnd = cum[i];
  const frac = segEnd > segStart ? (t - segStart) / (segEnd - segStart) : 0;
  const [lat1, lng1] = latlngs[i - 1];
  const [lat2, lng2] = latlngs[i];
  return [lat1 + (lat2 - lat1) * frac, lng1 + (lng2 - lng1) * frac];
}

function buildStepBoundaries(route) {
  let cum = 0;
  return route.legs[0].steps.map((s) => {
    cum += s.distance / 1000;
    return cum;
  });
}

const nav = {
  animId: null,
  marker: null,
  latlngs: null,
  cum: null,
  stepBounds: null,
  steps: null,
  totalKm: 0,
  totalDurationSec: 0,
  playbackSec: 0,
  startTime: 0,
  hospitalName: "",
};

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function startNavigation(hospital, route, latlngs) {
  cancelAnimationFrame(nav.animId);
  nav.latlngs = latlngs;
  nav.cum = buildCoordCumDistances(latlngs);
  nav.totalKm = nav.cum[nav.cum.length - 1];
  nav.stepBounds = buildStepBoundaries(route);
  nav.steps = route.legs[0].steps;
  nav.totalDurationSec = route.duration;
  nav.playbackSec = Math.max(15, Math.min(45, route.duration / 20));
  nav.hospitalName = hospital.name;
  if (state.incident) {
    // Tell the dispatcher where the crew is actually taking the patient.
    state.incident = incidents.setDestination(state.incident.caseRef, {
      name: hospital.name,
      orgCode: hospital.orgCode,
      etaText: formatMins(route.duration / 60),
    }) || state.incident;
  }
  nav.hospitalWait = hospital.wait || null;
  nav.startTime = performance.now();

  els.navArrived.hidden = true;
  els.navHospitalName.textContent = `To ${hospital.name}`;
  els.navOverlay.hidden = false;
  document.body.classList.add("nav-active");
  requestAnimationFrame(() => map.invalidateSize());

  if (nav.marker) map.removeLayer(nav.marker);
  nav.marker = L.marker(latlngs[0], { icon: emojiIcon("🚑", 26) }).addTo(map);
  map.setView(latlngs[0], 16);

  // Pre-alert the receiving ED as the crew rolls, so the hospital console sees it coming.
  const injury = INJURY_TYPES.find((i) => i.value === state.injuryType);
  const sev = SEVERITIES.find((x) => x.value === state.severity);
  alerts.send({
    hospital: hospital.name,
    orgCode: hospital.orgCode,
    pathway: state.incident?.pathway || injury?.label || "Emergency",
    etaText: formatMins(route.duration / 60),
    patientSummary: sev ? sev.label : "Unknown severity",
    origin: state.accident?.label || "Scene",
    conditionNotes: state.incident?.conditionNotes?.length
      ? state.incident.conditionNotes
      : [injury?.label, sev?.label].filter(Boolean),
    dispatcherOverride: false,
  });

  nav.animId = requestAnimationFrame(navTick);
}

function navTick() {
  const elapsed = (performance.now() - nav.startTime) / 1000;
  const fraction = Math.min(1, elapsed / nav.playbackSec);
  const targetKm = fraction * nav.totalKm;

  const pos = pointAtDistance(nav.latlngs, nav.cum, targetKm);
  nav.marker.setLatLng(pos);
  map.panTo(pos, { animate: false });

  let stepIdx = nav.stepBounds.findIndex((b) => targetKm < b);
  if (stepIdx === -1) stepIdx = nav.steps.length - 1;
  const upcoming = nav.steps[Math.min(stepIdx + 1, nav.steps.length - 1)];
  const distToManeuverKm = Math.max(0, (nav.stepBounds[stepIdx] ?? nav.totalKm) - targetKm);

  const onFinalStep = stepIdx >= nav.steps.length - 2;
  const displayStep = onFinalStep ? nav.steps[nav.steps.length - 1] : upcoming;

  els.navIcon.textContent = maneuverIcon(displayStep);
  els.navText.textContent = stepInstruction(displayStep);
  els.navDistance.textContent = distToManeuverKm < 0.1 ? "Now" : `${Math.round(distToManeuverKm * 1000)} m`;

  const remainingKm = nav.totalKm - targetKm;
  const remainingSec = nav.totalDurationSec * (1 - fraction);
  els.navRemainingDist.textContent = `${remainingKm.toFixed(1)} km`;
  els.navRemainingTime.textContent = formatMins(remainingSec / 60);
  els.navEtaClock.textContent = formatClock(new Date(Date.now() + remainingSec * 1000));
  els.navProgressFill.style.width = `${fraction * 100}%`;

  if (fraction >= 1) {
    els.navArrivedHospital.textContent = nav.hospitalName;
    els.navArrivedWait.textContent = nav.hospitalWait
      ? `~${formatMins(nav.hospitalWait.rangeMin[0])}–${formatMins(nav.hospitalWait.rangeMin[1])} illustrative wait at destination`
      : "";
    els.navArrived.hidden = false;
    if (state.incident && state.incident.status !== "arrived") {
      state.incident = incidents.setStatus(state.incident.caseRef, "arrived") || state.incident;
    }
    return;
  }
  nav.animId = requestAnimationFrame(navTick);
}

function endNavigation() {
  cancelAnimationFrame(nav.animId);
  nav.animId = null;
  els.navOverlay.hidden = true;
  document.body.classList.remove("nav-active");
  requestAnimationFrame(() => map.invalidateSize());
}

els.navEndBtn.addEventListener("click", () => {
  endNavigation();
  els.rankSection.hidden = false;
});
els.navArrivedCloseBtn.addEventListener("click", () => {
  // Patient handed over: the job closes on the dispatcher's board too.
  if (state.incident) {
    incidents.setStatus(state.incident.caseRef, "handover");
    state.incident = null;
    state.asDispatched = null;
    els.incidentSection.hidden = true;
    els.incidentAmend.hidden = true;
  }
  endNavigation();
  els.rankSection.hidden = false;
});

els.locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setAccident(pos.coords.latitude, pos.coords.longitude, "Current location");
      map.setView([pos.coords.latitude, pos.coords.longitude], 14);
    },
    (err) => alert(`Could not get location: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

map.on("click", (e) => {
  document.querySelectorAll(".hotspot-btn").forEach((b) => b.classList.remove("active"));
  setAccident(e.latlng.lat, e.latlng.lng);
});

/* ---------------- init ---------------- */

function drawHospitals() {
  state.hospitals.forEach((h) => {
    const major = h.aeType === 1;
    L.marker([h.lat, h.lng], { icon: dotIcon(major ? "#2ecc71" : "#6d8095", major ? 8 : 6) })
      .bindTooltip(`${h.name}${h.services ? " — " + h.services.join(", ") : ""}`)
      .addTo(hospitalLayer);
  });
}

function drawHotspots() {
  state.hotspots.forEach((s) => {
    L.marker([s.lat, s.lng], { icon: dotIcon("#f5a623", 9) }).bindTooltip(s.name).addTo(hotspotLayer);
  });
}

Promise.all([
  fetch("hospitals.json").then((r) => r.json()),
  fetch("hotspots.json").then((r) => r.json()),
  fetch("data/nhs-trusts.json").then((r) => r.json()),
  fetch("data/arrival-curve.json").then((r) => r.json()),
])
  .then(([hospitals, hotspots, nhs, curve]) => {
    state.hospitals = hospitals;
    state.hotspots = hotspots;
    state.nhs = nhs;
    state.curve = curve;
    drawHospitals();
    drawHotspots();
    renderSeverityGrid();
    renderInjuryGrid();
    renderHotspotList();

    // Pick up whatever dispatch has already sent, then keep listening for new jobs.
    incidents.onChange(watchIncoming);
    const open = incidents.latestOpen();
    if (open) applyIncident(open);
  })
  .catch((err) => {
    els.hotspotList.innerHTML = `<p class="hint">Failed to load data. Serve this over http://, not file://. (${err.message})</p>`;
  });
