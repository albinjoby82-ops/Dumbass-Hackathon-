import { BLANK_CONDITION, buildProfile } from './src/clinical.js';
import { CapacityService } from './src/capacity.js';
import { AlertService } from './src/alerts.js';
import { IncidentChannel } from './src/incidents.js';
import { selectCandidates, rank, compareToNearest, haversineKm } from './src/engine.js';

const LONDON_CENTER = [51.5074, -0.1278];
const OSRM_BASE = 'https://router.project-osrm.org';
const MAX_CANDIDATES = 8;

const map = L.map('map').setView(LONDON_CENTER, 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const hospitalLayer = L.layerGroup().addTo(map);
const dispatchLayer = L.layerGroup().addTo(map);

const $ = (id) => document.getElementById(id);
const resultsBody = $('results-body');
const locationStatus = $('location-status');
const capacityBlock = $('capacity-block');
const capacityList = $('capacity-list');
const crewBlock = $('crew-block');
const crewBody = $('crew-body');

let hospitals = [];
let hotspots = [];
let caps = null;
let nhs = null;
let curve = null;
let capacity = null;
let patient = null;
let token = 0;
let lastRanked = [];
let lastProfile = null;
let lastTopName = null;
const alerts = new AlertService();
const incidents = new IncidentChannel();
let lastCaseRef = null;

/* ------------------------------------------------------------------ helpers */

function dotIcon(color, size, ring) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${ring || '#fff'};box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function formatMins(mins) {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const sim = (text) => `<span class="simulated">${text}<em>simulated</em></span>`;

function condition() {
  return {
    ...BLANK_CONDITION,
    majorTrauma: $('c-trauma').checked,
    suspectedStroke: $('c-stroke').checked,
    suspectedCardiac: $('c-cardiac').checked,
    majorBleeding: $('c-bleeding').checked,
    unconscious: $('c-unconscious').checked,
    breathing: $('breathing').value,
    severity: $('severity').value,
    ageGroup: $('age-group').value
  };
}

function selection() {
  return {
    monthKey: $('month-select').value,
    monthLabel: $('month-select').selectedOptions[0]?.textContent ?? '',
    day: Number($('day-select').value),
    hour: Number($('hour-select').value)
  };
}

/* ------------------------------------------------------------------ routing */

async function fetchDurations(from, targets) {
  const coords = [from, ...targets].map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM_BASE}/table/v1/driving/${coords}?sources=0&annotations=duration`);
  if (!res.ok) throw new Error(`routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('no drive times available');
  return data.durations[0].slice(1).map((s) => (s == null ? null : s / 60));
}

async function fetchRoute(from, to) {
  const url = `${OSRM_BASE}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('no drivable route');
  return data.routes[0];
}

/* ------------------------------------------------------------------- render */

function capabilityChips(entry) {
  return entry.tags
    .filter((t) => t !== 'TYPE1_ED')
    .map((t) => {
      const unver = entry.unverified.includes(t);
      return `<span class="chip${unver ? ' unverified' : ''}">${t}${unver ? ' ?' : ''}</span>`;
    })
    .join('');
}

function renderCard(entry, i, profile) {
  const c = entry.capacity;
  const statusClass = c.status === 'divert' ? 'divert' : c.status === 'pressure' ? 'pressure' : '';
  return `
    <div class="card ${i === 0 ? 'best' : ''}">
      <p class="card-label">${i === 0 ? 'Recommended' : `Option ${i + 1}`}</p>
      <p class="hospital-name">${entry.hospital.name}</p>
      <div class="chips">${capabilityChips(entry)}</div>
      <div class="row"><span class="k">Travel time</span><span class="v">${entry.travelMin == null ? '—' : formatMins(entry.travelMin)}</span></div>
      <div class="row"><span class="k">ED status</span><span class="v ${statusClass}">${sim(c.statusLabel)}</span></div>
      <div class="row"><span class="k">Ambulances waiting</span><span class="v">${sim(String(c.ambulancesWaiting))}</span></div>
      ${c.breachRate != null
        ? `<div class="row"><span class="k">4hr breaches</span><span class="v">${(c.breachRate * 100).toFixed(1)}% of Type 1</span></div>`
        : ''}
      ${entry.reasons.length ? `<ul class="reasons">${entry.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>` : ''}
    </div>`;
}

function renderRanking(ranked, profile, excluded, fallback) {
  const cmp = compareToNearest(ranked);

  let html = `<div class="pathway"><span class="pathway-label">Pathway</span>${profile.pathway}</div>`;
  html += `<ul class="rationale">${profile.rationale.map((r) => `<li>${r}</li>`).join('')}</ul>`;

  if (fallback) {
    html +=
      `<p class="warn">No hospital in the dataset holds the required capability ` +
      `(${profile.requiredTags.join(' + ')}). Widened to any major A&amp;E — this needs a dispatcher decision.</p>`;
  }

  html += ranked.slice(0, 3).map((e, i) => renderCard(e, i, profile)).join('');

  if (cmp) {
    html +=
      `<p class="verdict">${cmp.nearest.hospital.name} is ${cmp.extraMin} min closer, ` +
      `but ${cmp.cause} — so ${cmp.top.hospital.name} ranks first.</p>`;
  }

  const bypassed = excluded
    .filter((h) => patient && haversineKm(patient, h) < (ranked[0] ? haversineKm(patient, ranked[0].hospital) : Infinity))
    .slice(0, 4);

  if (bypassed.length && !fallback) {
    html +=
      `<p class="bypass"><strong>Closer, but bypassed</strong> — lacks ` +
      `${profile.requiredTags.filter((t) => t !== 'TYPE1_ED').join(' + ') || 'the required capability'}: ` +
      bypassed.map((h) => h.name).join(', ') + '.</p>';
  }

  // Pre-alert: the dispatcher accepts (or overrides) the recommendation before it is sent.
  html +=
    `<div class="prealert">` +
    `<label for="alert-target">Send pre-alert to</label>` +
    `<select id="alert-target">` +
    ranked.slice(0, 5).map((e, i) =>
      `<option value="${i}">${e.hospital.name}${i === 0 ? ' — recommended' : ''}</option>`).join('') +
    `</select>` +
    `<button id="send-alert" type="button">Send pre-alert</button>` +
    `<p class="alert-sent" id="alert-sent" hidden></p>` +
    `</div>`;

  // Crew hand-off: the same incident, pushed to the driver console with the detail
  // preloaded. The crew re-assess on scene and can change any of it.
  html +=
    `<div class="crew-dispatch">` +
    `<p class="crew-title">Send to ambulance crew</p>` +
    `<label for="dispatch-target">Destination shown to crew</label>` +
    `<select id="dispatch-target">` +
    ranked.slice(0, 5).map((e, i) =>
      `<option value="${i}">${e.hospital.name}${i === 0 ? ' — recommended' : ''}</option>`).join('') +
    `</select>` +
    `<button id="send-dispatch" type="button">Send to driver console</button>` +
    `<p class="hint">This sends the incident and opens the driver console with the location, severity, ` +
    `condition and suggested destination preloaded. The crew can amend it from the scene.</p>` +
    `<p class="alert-sent" id="dispatch-sent" hidden></p>` +
    `</div>`;

  const topName = ranked[0]?.hospital.name ?? null;
  const changed = lastTopName !== null && topName !== lastTopName;
  lastTopName = topName;

  resultsBody.className = '';
  resultsBody.innerHTML = html;

  // Draw the eye when the recommendation itself flips — usually a divert landing.
  if (changed) {
    const card = resultsBody.querySelector('.card.best');
    if (card) {
      card.classList.add('flash');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  document.getElementById('send-alert')?.addEventListener('click', sendPreAlert);
  document.getElementById('send-dispatch')?.addEventListener('click', dispatchToCrew);
}

function conditionNotes(c) {
  const n = [];
  if (c.majorTrauma) n.push('Major trauma');
  if (c.suspectedStroke) n.push('Suspected stroke — FAST positive');
  if (c.suspectedCardiac) n.push('Suspected heart attack');
  if (c.majorBleeding) n.push('Major bleeding');
  if (c.unconscious) n.push('Unconscious');
  if (c.breathing === 'absent') n.push('NOT BREATHING');
  else if (c.breathing === 'difficulty') n.push('Breathing difficulty');
  return n;
}

function sendPreAlert() {
  const idx = Number(document.getElementById('alert-target').value);
  const entry = lastRanked[idx];
  if (!entry || !lastProfile) return;

  const c = condition();
  const overridden = idx !== 0;

  const rec = alerts.send({
    hospital: entry.hospital.name,
    orgCode: entry.hospital.orgCode,
    pathway: lastProfile.pathway,
    etaText: entry.travelMin == null ? 'unknown' : formatMins(entry.travelMin),
    patientSummary: `${c.ageGroup === 'child' ? 'Child' : 'Adult'}, ${c.severity}`,
    origin: patient.label || `${patient.lat.toFixed(4)}, ${patient.lng.toFixed(4)}`,
    conditionNotes: conditionNotes(c),
    dispatcherOverride: overridden
  });

  const el = document.getElementById('alert-sent');
  el.hidden = false;
  el.textContent =
    `${rec.caseRef} sent to ${entry.hospital.name}` +
    (overridden ? ' — dispatcher override of the recommendation.' : '.');
}

/* ------------------------------------------------------- hand-off to the crew */

/**
 * The driver console works in a coarser vocabulary than the dispatcher form: one severity
 * band and one condition type, because that is what a crew picks on a phone at a scene.
 * These two functions translate the dispatcher's assessment into it. The crew can change
 * either one once they are looking at the patient.
 */
function crewSeverity(c) {
  if (c.breathing === 'absent' || c.unconscious) return 'critical';
  if (c.severity === 'severe') return 'serious';
  if (c.severity === 'moderate') return 'moderate';
  return 'minor';
}

function crewInjuryType(c) {
  if (c.majorTrauma || c.majorBleeding) return 'trauma';
  if (c.suspectedStroke) return 'stroke';
  if (c.suspectedCardiac) return 'cardiac';
  if (c.unconscious || c.breathing !== 'normal') return 'medical';
  return 'other';
}

function dispatchToCrew() {
  // Open the console from the user gesture so popup blockers do not prevent the
  // driver view from appearing after the incident is saved.
  const driverWindow = window.open('dispatch.html', '_blank', 'noopener');
  const idx = Number(document.getElementById('dispatch-target').value);
  const entry = lastRanked[idx];
  if (!entry || !lastProfile || !patient) return;

  const c = condition();
  const sel = selection();

  const rec = incidents.dispatch({
    location: {
      lat: patient.lat,
      lng: patient.lng,
      label: patient.label || `${patient.lat.toFixed(4)}, ${patient.lng.toFixed(4)}`
    },
    severity: crewSeverity(c),
    injuryType: crewInjuryType(c),
    pathway: lastProfile.pathway,
    conditionNotes: conditionNotes(c),
    ageGroup: c.ageGroup,
    breathing: c.breathing,
    dispatcherSeverity: c.severity,
    recommendation: {
      name: entry.hospital.name,
      orgCode: entry.hospital.orgCode,
      etaText: entry.travelMin == null ? 'unknown' : formatMins(entry.travelMin),
      overridden: idx !== 0
    },
    timeContext: { monthKey: sel.monthKey, day: sel.day, hour: sel.hour }
  });

  lastCaseRef = rec.caseRef;
  const el = document.getElementById('dispatch-sent');
  el.hidden = false;
  el.innerHTML = `${rec.caseRef} sent to the crew — driver console preloaded.` +
    (driverWindow ? '' : ' <a href="dispatch.html" target="_blank" rel="noopener">Open driver console</a>');
  renderCrew();
}

const CREW_STATUS = {
  dispatched: 'Dispatched — crew has not confirmed yet',
  'on-scene': 'On scene — crew assessing',
  'en-route': 'En route to destination',
  arrived: 'Arrived at destination',
  handover: 'Handover complete',
  cancelled: 'Stood down'
};

function renderCrew() {
  const inc = (lastCaseRef && incidents.get(lastCaseRef)) || incidents.latestOpen();
  if (!inc) {
    crewBlock.hidden = true;
    return;
  }
  crewBlock.hidden = false;

  const amendments = inc.amendments || [];
  crewBody.innerHTML =
    `<div class="crew-card">` +
    `<div class="crew-head"><span class="case-ref">${inc.caseRef}</span>` +
    `<span class="crew-status ${inc.status}">${CREW_STATUS[inc.status] || inc.status}</span></div>` +
    `<div class="row"><span class="k">Scene</span><span class="v">${inc.location.label}</span></div>` +
    `<div class="row"><span class="k">Dispatched as</span><span class="v">${inc.pathway}</span></div>` +
    (inc.destination
      ? `<div class="row"><span class="k">Crew destination</span><span class="v">${inc.destination.name}` +
        (inc.destination.name !== inc.recommendation.name ? ' — crew choice' : '') + `</span></div>`
      : '') +
    (amendments.length
      ? `<p class="crew-amend-label">Amended on scene</p>` +
        `<ul class="reasons">${amendments.map((a) => `<li>${a}</li>`).join('')}</ul>`
      : `<p class="hint">No changes from the crew yet.</p>`) +
    `</div>`;
}

function renderCapacityControls(entries) {
  capacityList.innerHTML = entries
    .map((e) => {
      const code = e.hospital.orgCode;
      const cur = e.capacity.status;
      return `
        <div class="cap-row">
          <span class="cap-name">${e.hospital.name}</span>
          <select data-org="${code}" class="cap-select">
            <option value="normal"${cur === 'normal' ? ' selected' : ''}>Normal</option>
            <option value="pressure"${cur === 'pressure' ? ' selected' : ''}>Pressure</option>
            <option value="divert"${cur === 'divert' ? ' selected' : ''}>Divert</option>
          </select>
        </div>`;
    })
    .join('');
  capacityBlock.hidden = false;

  capacityList.querySelectorAll('.cap-select').forEach((sel) => {
    sel.addEventListener('change', () => capacity.setStatus(sel.dataset.org, sel.value));
  });
}

/* ----------------------------------------------------------------- recommend */

async function recommend() {
  if (!patient) return;
  const myToken = ++token;
  const sel = selection();
  const profile = buildProfile(condition());

  const { candidates, fallback, excluded } = selectCandidates(hospitals, caps, profile);

  const nearby = candidates
    .map((h) => ({ h, km: haversineKm(patient, h) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.h);

  resultsBody.className = '';
  resultsBody.innerHTML =
    `<div class="loading"><span class="spinner"></span>Ranking ${nearby.length} eligible destinations…</div>` +
    `<div class="skeleton"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w60"></div></div>`;

  let travelMin;
  try {
    travelMin = await fetchDurations(patient, nearby);
  } catch (err) {
    if (myToken !== token) return;
    resultsBody.innerHTML = `<p class="status error">Routing unavailable: ${err.message}</p>`;
    return;
  }
  if (myToken !== token) return;

  const capacityStates = nearby.map((h) => {
    const s = capacity.simulateState(h.orgCode, sel.monthKey, sel.day, sel.hour);
    return { ...s, penalty: capacity.penalty(s) };
  });

  const ranked = rank({ candidates: nearby, travelMin, capacityStates, profile, caps });

  lastRanked = ranked;
  lastProfile = profile;

  renderRanking(ranked, profile, excluded, fallback);
  renderCapacityControls(ranked.slice(0, 5));
  drawDispatch(ranked, myToken);
}

async function drawDispatch(ranked, myToken) {
  dispatchLayer.clearLayers();
  L.marker([patient.lat, patient.lng], { icon: dotIcon('#ff4d4d', 16) })
    .bindPopup(`<strong>Patient</strong><br>${patient.label || 'Selected point'}`)
    .addTo(dispatchLayer);

  const top = ranked[0];
  if (!top) return;

  L.marker([top.hospital.lat, top.hospital.lng], { icon: dotIcon('#3aa0ff', 16) })
    .bindPopup(`<strong>${top.hospital.name}</strong><br>Recommended destination`)
    .addTo(dispatchLayer);

  try {
    const route = await fetchRoute(patient, top.hospital);
    if (myToken !== token) return;
    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color: '#1b2a3a', weight: 8, opacity: 0.3 }).addTo(dispatchLayer);
    L.polyline(latlngs, { color: '#3aa0ff', weight: 4, opacity: 0.95 }).addTo(dispatchLayer);
    map.fitBounds(L.latLngBounds(latlngs).pad(0.15));
  } catch {
    map.fitBounds(
      L.latLngBounds([[patient.lat, patient.lng], [top.hospital.lat, top.hospital.lng]]).pad(0.25)
    );
  }
}

/* ---------------------------------------------------------------- location */

function setPatient(p) {
  patient = p;
  locationStatus.textContent = p.label
    ? `${p.label} — ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`
    : `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  locationStatus.classList.remove('error');
  recommend();
}

/* -------------------------------------------------------------------- setup */

function drawHospitals() {
  hospitals.forEach((h) => {
    const tags = h.services ? [...h.services] : [];
    if (h.aeType === 1) tags.push('TYPE1_ED');
    const specialist = tags.some((t) => ['MTC', 'HASU', 'HAC'].includes(t));
    const color = h.aeType === null ? '#c58bf0' : specialist ? '#2ecc71' : '#7f93a8';
    L.marker([h.lat, h.lng], { icon: dotIcon(color, specialist ? 10 : 8) })
      .bindPopup(
        `<strong>${h.name}</strong><br>${tags.length ? tags.join(', ') : 'No designated capability'}` +
        (h.siteNote ? `<br><em>${h.siteNote}</em>` : '')
      )
      .addTo(hospitalLayer);
  });
}

function populateControls() {
  hotspots.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = s.name;
    $('hotspot-select').appendChild(o);
  });

  nhs.periods.slice().reverse().forEach((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.label;
    $('month-select').appendChild(o);
  });

  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((d, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = d;
    $('day-select').appendChild(o);
  });
  $('day-select').value = '6';

  for (let h = 0; h < 24; h++) {
    const o = document.createElement('option');
    o.value = String(h);
    o.textContent = `${String(h).padStart(2, '0')}:00`;
    $('hour-select').appendChild(o);
  }
  $('hour-select').value = '20';

  const assumed = curve.source !== 'provider';
  $('method-note').innerHTML =
    `<strong>Real:</strong> clinical designations (Major Trauma Centre, HASU, heart attack centre) are published NHS pathway ` +
    `designations, each cited in <code>data/hospital-capabilities.json</code>. Travel times come from the OSRM road network. ` +
    `Four-hour breach rates are NHS England monthly data, ${nhs.periods[0].label}–${nhs.periods.at(-1).label}.<br>` +
    `<strong>Simulated:</strong> live ED status, ambulance queue depth and divert status. No public real-time feed exists ` +
    `for any of these — the camera-based capacity counting in the spec would feed this same interface.<br>` +
    (assumed ? `<strong>Assumption:</strong> the hour-of-day demand curve is not NHS-sourced.<br>` : '') +
    `<strong>Unconfirmed:</strong> designations marked <span class="chip unverified">?</span> have secondary evidence only ` +
    `and must be verified before operational use.<br>` +
    `<strong>Not a clinical tool.</strong> This demonstrates routing logic; every recommendation is dispatcher-overridable.`;
}

$('hotspot-select').addEventListener('change', (e) => {
  const s = hotspots[Number(e.target.value)];
  if (s) setPatient({ lat: s.lat, lng: s.lng, label: s.name });
});

$('set-location').addEventListener('click', () => {
  const lat = parseFloat($('lat-input').value);
  const lng = parseFloat($('lng-input').value);
  if (!isFinite(lat) || !isFinite(lng) || lat < 49 || lat > 61 || lng < -11 || lng > 3) {
    locationStatus.textContent = 'Enter a valid latitude and longitude within the UK.';
    locationStatus.classList.add('error');
    return;
  }
  $('hotspot-select').value = '';
  setPatient({ lat, lng });
});

$('use-gps').addEventListener('click', () => {
  if (!navigator.geolocation) {
    locationStatus.textContent = 'Device location unavailable — enter it manually.';
    locationStatus.classList.add('error');
    return;
  }
  locationStatus.textContent = 'Requesting device location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setPatient({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Device location' }),
    () => {
      locationStatus.textContent = 'Device location denied or unavailable — enter it manually.';
      locationStatus.classList.add('error');
    },
    { timeout: 8000 }
  );
});

['c-trauma', 'c-stroke', 'c-cardiac', 'c-bleeding', 'c-unconscious',
  'breathing', 'severity', 'age-group', 'month-select', 'day-select', 'hour-select']
  .forEach((id) => $(id).addEventListener('change', recommend));

$('clear-overrides').addEventListener('click', () => capacity.clearAll());

map.on('click', (e) => {
  $('hotspot-select').value = '';
  setPatient({ lat: e.latlng.lat, lng: e.latlng.lng });
});

async function init() {
  try {
    const [h, s, c, t, cv] = await Promise.all([
      fetch('hospitals.json').then((r) => r.json()),
      fetch('hotspots.json').then((r) => r.json()),
      fetch('data/hospital-capabilities.json').then((r) => r.json()),
      fetch('data/nhs-trusts.json').then((r) => r.json()),
      fetch('data/arrival-curve.json').then((r) => r.json())
    ]);
    hospitals = h; hotspots = s; caps = c; nhs = t; curve = cv;
    capacity = new CapacityService(nhs, curve);
    capacity.onChange(recommend);
    incidents.onChange(renderCrew);
    renderCrew();
    drawHospitals();
    populateControls();
  } catch (err) {
    resultsBody.className = '';
    resultsBody.innerHTML = `<p class="status error">Failed to load data: ${err.message}. Serve over http:// rather than opening the file directly.</p>`;
  }
}

init();
