/* Driver dispatch UI — severity + injury type -> ranked hospital list -> directions */

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
};

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

  return {
    trustName: trust.name,
    breachRate: breach,
    medianMin: Math.round(medianHours * 60),
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
};

function renderSeverityGrid() {
  els.severityGrid.innerHTML = "";
  SEVERITIES.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.style.setProperty("--accent-color", s.color);
    btn.innerHTML = `<span class="choice-label">${s.label}</span><span class="choice-desc">${s.desc}</span>`;
    btn.addEventListener("click", () => {
      state.severity = s.value;
      document.querySelectorAll("#severityGrid .choice-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      maybeRank();
    });
    els.severityGrid.appendChild(btn);
  });
}

function renderInjuryGrid() {
  els.injuryGrid.innerHTML = "";
  INJURY_TYPES.forEach((i) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.innerHTML = `<span class="choice-label">${i.label}</span><span class="choice-desc">${i.desc}</span>`;
    btn.addEventListener("click", () => {
      state.injuryType = i.value;
      document.querySelectorAll("#injuryGrid .choice-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      maybeRank();
    });
    els.injuryGrid.appendChild(btn);
  });
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
  maybeRank();
}

function resetDownstream() {
  state.ranked = [];
  state.chosen = null;
  els.rankSection.hidden = true;
  els.enrouteSection.hidden = true;
}

async function maybeRank() {
  if (!state.accident || !state.severity || !state.injuryType) return;
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
        ? `<span class="rank-wait">~${formatMins(h.wait.medianMin)} modelled wait</span>`
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
          <span class="rank-drive">${formatMins(h.driveMin)} drive</span>
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
  els.enrouteHospital.textContent = hospital.name;
  els.enrouteEta.textContent = "Calculating…";
  els.enrouteDist.textContent = "";
  els.enrouteWait.textContent = hospital.wait ? `~${formatMins(hospital.wait.medianMin)} modelled wait at destination` : "";
  els.directionsList.innerHTML = "";

  dispatchLayer.clearLayers();
  L.marker([state.accident.lat, state.accident.lng], { icon: emojiIcon("🚧", 28) }).addTo(dispatchLayer);
  L.marker([hospital.lat, hospital.lng], { icon: emojiIcon("🏥", 30) }).addTo(dispatchLayer).bindTooltip(hospital.name);

  try {
    const route = await fetchRoute(state.accident, hospital);
    els.enrouteEta.textContent = formatMins(route.duration / 60);
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
  })
  .catch((err) => {
    els.hotspotList.innerHTML = `<p class="hint">Failed to load data. Serve this over http://, not file://. (${err.message})</p>`;
  });
