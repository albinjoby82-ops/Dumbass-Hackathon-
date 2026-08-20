import { BLANK_CONDITION, buildProfile } from './src/clinical.js';
import { CapacityService } from './src/capacity.js';
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

let hospitals = [];
let hotspots = [];
let caps = null;
let nhs = null;
let curve = null;
let capacity = null;
let patient = null;
let token = 0;

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

  resultsBody.className = '';
  resultsBody.innerHTML = html;
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
  resultsBody.innerHTML = `<p class="status">Ranking ${nearby.length} eligible destinations…</p>`;

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
    const tags = caps.sites[h.name]?.tags ?? [];
    const specialist = tags.some((t) => ['MTC', 'HASU', 'PPCI'].includes(t));
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
    drawHospitals();
    populateControls();
  } catch (err) {
    resultsBody.className = '';
    resultsBody.innerHTML = `<p class="status error">Failed to load data: ${err.message}. Serve over http:// rather than opening the file directly.</p>`;
  }
}

init();
