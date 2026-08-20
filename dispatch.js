/* Driver dispatch UI — severity + injury type -> ranked hospital list -> directions.
 *
 * The incident normally arrives preloaded from the dispatcher console (src/incidents.js):
 * the crew is already on scene, so location, severity and condition are filled in and the
 * crew's job is to confirm or correct them from what they can actually see. Everything
 * stays editable, and every change is reported back to the dispatcher.
 */

import { IncidentChannel } from "./src/incidents.js";
import { RouteProgress, DriveSimulator, maneuverIcon, instructionText, formatDistance } from "./src/navigation.js";
import { CapacityService } from "./src/capacity.js";
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
let capacity = null; // needs the NHS data, so constructed after load

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
  enrouteSection: document.getElementById("enrouteSection"),
  enrouteHospital: document.getElementById("enrouteHospital"),
  enrouteEta: document.getElementById("enrouteEta"),
  enrouteDist: document.getElementById("enrouteDist"),
  enrouteWait: document.getElementById("enrouteWait"),
  directionsList: document.getElementById("directionsList"),
  changeHospitalBtn: document.getElementById("changeHospitalBtn"),
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
  els.enrouteSection.hidden = true;
}

function updateConfirmSummary() {
  if (!state.accident || !state.severity || !state.injuryType) return;

  // Any change to location/severity/injury invalidates a ranking already shown.
  els.rankSection.hidden = true;
  els.enrouteSection.hidden = true;

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
  els.enrouteSection.hidden = true;
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
  els.rankSection.hidden = true;
  els.enrouteSection.hidden = false;
  navigation.prepare(hospital);
  els.enrouteHospital.textContent = hospital.name;
  els.enrouteEta.textContent = "Calculating…";
  els.enrouteDist.textContent = "";
  els.enrouteWait.textContent = hospital.wait
    ? `~${formatMins(hospital.wait.rangeMin[0])}–${formatMins(hospital.wait.rangeMin[1])} illustrative wait at destination`
    : "";
  els.directionsList.innerHTML = "";

  dispatchLayer.clearLayers();
  L.marker([state.accident.lat, state.accident.lng], { icon: emojiIcon("🚧", 28) }).addTo(dispatchLayer);
  L.marker([hospital.lat, hospital.lng], { icon: emojiIcon("🏥", 30) }).addTo(dispatchLayer).bindTooltip(hospital.name);

  try {
    const route = await fetchRoute(state.accident, hospital);
    els.enrouteEta.textContent = `${formatMins(route.duration / 60)} normal drive`;
    if (state.incident) {
      state.incident = incidents.setDestination(state.incident.caseRef, {
        name: hospital.name,
        orgCode: hospital.orgCode,
        etaText: formatMins(route.duration / 60),
      }) || state.incident;
    }
    els.enrouteDist.textContent = `${(route.distance / 1000).toFixed(2)} km`;

    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color: "#1b2a3a", weight: 8, opacity: 0.3 }).addTo(dispatchLayer);
    L.polyline(latlngs, { color: "#3aa0ff", weight: 4, opacity: 0.95 }).addTo(dispatchLayer);
    map.fitBounds(L.latLngBounds(latlngs).pad(0.15));

    route.legs[0].steps.forEach((step, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="step-idx">${i + 1}.</span><span>${stepInstruction(step)} — ${(step.distance / 1000).toFixed(2)} km</span>`;
      els.directionsList.appendChild(li);
    });

    navigation.setRoute(hospital, route);
  } catch (err) {
    els.enrouteEta.textContent = "Route unavailable";
    console.error(err);
  }
}

els.changeHospitalBtn.addEventListener("click", () => {
  els.enrouteSection.hidden = true;
  els.rankSection.hidden = false;
});

els.newIncidentBtn.addEventListener("click", () => {
  state.accident = null;
  state.severity = null;
  state.injuryType = null;
  document.querySelectorAll(".choice-btn.active, .hotspot-btn.active").forEach((b) => b.classList.remove("active"));
  els.accidentStatus.textContent = "Not set";
  resetDownstream();
  dispatchLayer.clearLayers();
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

/* ---------------- navigation ---------------- */

/**
 * Full-screen turn-by-turn view. A web page cannot launch Apple CarPlay — that needs a
 * native app and an Apple entitlement — so this is the same experience rendered in the
 * browser, running our own route rather than handing off to another maps app.
 *
 * Position comes from real GPS or from the simulator, because a demo indoors cannot
 * actually drive the route.
 */
const navigation = {
  map: null,
  progress: null,
  simulator: null,
  hospital: null,
  route: null,
  caseRef: null,
  watchId: null,
  vehicle: null,
  el: {},

  init() {
    this.el = {
      root: document.getElementById("nav"),
      arrow: document.getElementById("navArrow"),
      dist: document.getElementById("navDist"),
      text: document.getElementById("navText"),
      then: document.getElementById("navThen"),
      thenArrow: document.getElementById("navThenArrow"),
      thenText: document.getElementById("navThenText"),
      dest: document.getElementById("navDest"),
      caseRef: document.getElementById("navCase"),
      eta: document.getElementById("navEta"),
      remain: document.getElementById("navRemain"),
      km: document.getElementById("navKm"),
      simBtn: document.getElementById("navSimBtn"),
      gpsBtn: document.getElementById("navGpsBtn"),
      endBtn: document.getElementById("navEndBtn"),
      alert: document.getElementById("navAlert"),
      alertSub: document.getElementById("navAlertSub"),
      rerouteBtn: document.getElementById("navRerouteBtn"),
      dismissBtn: document.getElementById("navDismissBtn"),
      arrived: document.getElementById("navArrived"),
      arrivedSub: document.getElementById("navArrivedSub"),
      handoverBtn: document.getElementById("navHandoverBtn"),
    };

    this.el.simBtn.addEventListener("click", () => this.toggleSim());
    this.el.gpsBtn.addEventListener("click", () => this.toggleGps());
    this.el.endBtn.addEventListener("click", () => this.close());
    this.el.dismissBtn.addEventListener("click", () => { this.el.alert.hidden = true; });
    this.el.rerouteBtn.addEventListener("click", () => this.reroute());
    this.el.handoverBtn.addEventListener("click", () => {
      if (this.caseRef) alerts.setStatus(this.caseRef, "acknowledged");
      // Closes the job on the dispatcher's board as well as this screen.
      if (state.incident) {
        incidents.setStatus(state.incident.caseRef, "handover");
        state.incident = null;
        state.asDispatched = null;
        els.incidentSection.hidden = true;
        els.incidentAmend.hidden = true;
      }
      this.close();
    });

    // A hospital declaring divert mid-journey is the case this whole system exists for.
    capacity.onChange(() => this.checkDivert());
  },

  prepare(hospital) {
    this.hospital = hospital;
    this.el.dest.textContent = hospital.name;
    this.el.text.textContent = "Preparing route…";
    this.el.dist.textContent = "—";
  },

  setRoute(hospital, route) {
    this.hospital = hospital;
    this.route = route;
    this.progress = new RouteProgress(route);
    this.open();
  },

  open() {
    this.el.root.hidden = false;
    this.el.arrived.hidden = true;
    this.el.alert.hidden = true;

    if (!this.map) {
      this.map = L.map("navMap", { zoomControl: false, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(this.map);
      this.layer = L.layerGroup().addTo(this.map);
    }
    setTimeout(() => this.map.invalidateSize(), 60);

    const latlngs = this.progress.points.map((p) => [p.lat, p.lng]);
    this.layer.clearLayers();
    L.polyline(latlngs, { color: "#0b1c2c", weight: 14, opacity: .9 }).addTo(this.layer);
    L.polyline(latlngs, { color: "#3aa0ff", weight: 7, opacity: 1 }).addTo(this.layer);
    L.marker(latlngs.at(-1), { icon: emojiIcon("🏥", 30) }).addTo(this.layer);

    this.vehicle = L.marker(latlngs[0], {
      icon: L.divIcon({ className: "", html: '<div class="nav-vehicle"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).addTo(this.layer);

    // Send the pre-alert as navigation begins, so the ED knows before we roll.
    const injury = INJURY_TYPES.find((i) => i.value === state.injuryType);
    const sev = SEVERITIES.find((s) => s.value === state.severity);
    const rec = alerts.send({
      hospital: this.hospital.name,
      orgCode: this.hospital.orgCode,
      pathway: injury ? injury.label : "Emergency",
      etaText: formatMins(this.route.duration / 60),
      patientSummary: sev ? sev.label : "Unknown severity",
      origin: state.accident?.label || "Scene",
      conditionNotes: [injury?.label, sev?.label].filter(Boolean),
      dispatcherOverride: false,
    });
    this.caseRef = rec.caseRef;
    this.el.caseRef.textContent = state.incident ? `${state.incident.caseRef} · ${rec.caseRef}` : rec.caseRef;

    this.update(this.progress.stateAt(0));
    this.map.setView(latlngs[0], 16);
    this.checkDivert();
  },

  update(s) {
    if (!s) return;
    this.el.arrow.textContent = maneuverIcon(s.step);
    this.el.dist.textContent = formatDistance(s.distanceToManeuver);
    this.el.text.textContent = instructionText(s.step);

    if (s.nextStep) {
      this.el.then.hidden = false;
      this.el.thenArrow.textContent = maneuverIcon(s.nextStep);
      this.el.thenText.textContent = instructionText(s.nextStep);
    } else {
      this.el.then.hidden = true;
    }

    this.el.remain.textContent = formatMins(s.remainingSec / 60);
    this.el.km.textContent = `${(s.remainingM / 1000).toFixed(1)} km`;
    const arriveAt = new Date(Date.now() + s.remainingSec * 1000);
    this.el.eta.textContent = arriveAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (s.position) {
      this.vehicle.setLatLng([s.position.lat, s.position.lng]);
      this.map.panTo([s.position.lat, s.position.lng], { animate: true, duration: .3 });
    }

    if (s.arrived) this.onArrived();
  },

  onArrived() {
    this.simulator?.stop();
    if (state.incident && state.incident.status !== "arrived") {
      state.incident = incidents.setStatus(state.incident.caseRef, "arrived") || state.incident;
    }
    this.el.arrived.hidden = false;
    this.el.arrivedSub.textContent = `${this.hospital.name} — ${this.caseRef || ""}`;
    this.el.simBtn.classList.remove("active");
    this.el.simBtn.textContent = "▶ Simulate drive";
  },

  toggleSim() {
    if (!this.progress) return;
    if (this.simulator?.running) {
      this.simulator.stop();
      this.el.simBtn.textContent = "▶ Simulate drive";
      this.el.simBtn.classList.remove("active");
      return;
    }
    this.stopGps();
    if (!this.simulator) {
      this.simulator = new DriveSimulator(this.progress, { onTick: (s) => this.update(s) });
    }
    this.simulator.start();
    this.el.simBtn.textContent = "❚❚ Pause";
    this.el.simBtn.classList.add("active");
  },

  toggleGps() {
    if (this.watchId !== null) { this.stopGps(); return; }
    if (!navigator.geolocation) { alert("Geolocation is not available on this device."); return; }
    this.simulator?.stop();
    this.el.simBtn.textContent = "▶ Simulate drive";
    this.el.simBtn.classList.remove("active");
    this.el.gpsBtn.classList.add("active");
    this.el.gpsBtn.textContent = "GPS on";
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const snapped = this.progress.snap({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        this.update(this.progress.stateAt(snapped.distanceAlong));
      },
      (err) => { alert(`Location unavailable: ${err.message}`); this.stopGps(); },
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  },

  stopGps() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.el.gpsBtn.classList.remove("active");
    this.el.gpsBtn.textContent = "Follow GPS";
  },

  checkDivert() {
    if (!this.hospital || this.el.root.hidden) return;
    const status = capacity.overrides[this.hospital.orgCode];
    if (status === "divert") {
      const alt = state.ranked.find((h) => h.name !== this.hospital.name && capacity.overrides[h.orgCode] !== "divert");
      this.el.alertSub.textContent = alt
        ? `${this.hospital.name} has declared divert. Next best: ${alt.name} (${formatMins(alt.driveMin)} from scene).`
        : `${this.hospital.name} has declared divert. No alternative in the current shortlist.`;
      this.el.rerouteBtn.hidden = !alt;
      this._alt = alt || null;
      this.el.alert.hidden = false;
    } else {
      this.el.alert.hidden = true;
    }
  },

  reroute() {
    if (!this._alt) return;
    this.simulator?.stop();
    this.simulator = null;
    this.stopGps();
    this.el.alert.hidden = true;
    this.el.simBtn.textContent = "▶ Simulate drive";
    this.el.simBtn.classList.remove("active");
    chooseHospital(this._alt);
  },

  close() {
    this.simulator?.stop();
    this.simulator = null;
    this.stopGps();
    this.el.root.hidden = true;
    this.el.arrived.hidden = true;
  },
};


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
    capacity = new CapacityService(nhs, curve);
    navigation.init();
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
