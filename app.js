const LONDON_CENTER = [51.5074, -0.1278];
const OSRM_BASE = 'https://router.project-osrm.org';
const CANDIDATE_COUNT = 6;

/**
 * Only recommend diverting past the nearest A&E if the modelled saving is big enough to
 * outrun the model's own uncertainty. A few minutes' difference between two estimates
 * whose ranges overlap heavily is noise, and extra blue-light miles are not free.
 */
const MIN_SAVING_MIN = 15;

const map = L.map('map').setView(LONDON_CENTER, 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const hospitalLayer = L.layerGroup().addTo(map);
const hotspotLayer = L.layerGroup().addTo(map);
const dispatchLayer = L.layerGroup().addTo(map);

const resultsBody = document.getElementById('results-body');
const candidatesBlock = document.getElementById('candidates-block');
const candidatesList = document.getElementById('candidates');
const hotspotSelect = document.getElementById('hotspot-select');
const toggleHotspots = document.getElementById('toggle-hotspots');
const monthSelect = document.getElementById('month-select');
const daySelect = document.getElementById('day-select');
const hourSelect = document.getElementById('hour-select');
const methodNote = document.getElementById('method-note');

let hospitals = [];
let hotspots = [];
let nhs = null;
let curve = null;
let lastAccident = null;
let requestToken = 0;

/* ---------------------------------------------------------------- geometry */

function dotIcon(color, size) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Candidates for a blue-light dispatch are TYPE 1 (major A&E) only.
 * Type 3 sites are urgent care centres / walk-in centres and cannot receive
 * serious trauma — routing an ambulance there would be a real dispatch error.
 */
function rankHospitals(accident) {
  return hospitals
    .filter((h) => h.aeType === 1)
    .map((h) => ({ ...h, straightKm: haversineKm(accident, h) }))
    .sort((a, b) => a.straightKm - b.straightKm);
}

/* -------------------------------------------------------------- wait model */

/** Inverse standard normal CDF (Acklam's rational approximation). */
function normInv(p) {
  if (p <= 0 || p >= 1) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Spread of the time-in-department distribution (log scale). An assumption. */
const SIGMA = 0.8;

/**
 * MODELLED — not a measurement.
 *
 * Real inputs:
 *   - the trust's actual Type 1 four-hour breach rate for the selected month (NHS England)
 *   - a relative demand factor for the selected weekday/hour
 *
 * Method: NHS publishes the share of patients spending over 4 hours in A&E. We assume
 * time-in-department is lognormal with fixed spread SIGMA, and solve for the median that
 * reproduces the observed breach rate. Hour-of-day demand scales the breach rate first,
 * so busy periods push the whole distribution out.
 *
 * This estimates TOTAL TIME IN A&E (arrival to admission/discharge/transfer) because that
 * is what the 4-hour standard measures. Per-patient hourly waits are not public (ECDS is
 * DARS-gated), so this cannot be a lookup of what actually happened.
 */
function estimateWait(orgCode, monthKey, day, hour) {
  const trust = nhs?.trusts?.[orgCode];
  const month = trust?.months?.[monthKey];
  if (!month || month.type1BreachRate == null) return null;

  const demand = curve?.matrix?.[day]?.[hour] ?? 1;
  const breach = month.type1BreachRate;

  const effective = Math.min(0.95, Math.max(0.01, breach * demand));
  const medianHours = 4 * Math.exp(-SIGMA * normInv(1 - effective));

  return {
    trustName: trust.name,
    breachRate: breach,
    demand,
    medianMin: Math.round(medianHours * 60),
    p25Min: Math.round(medianHours * Math.exp(-0.6745 * SIGMA) * 60),
    p75Min: Math.round(medianHours * Math.exp(0.6745 * SIGMA) * 60)
  };
}

/* --------------------------------------------------------------- formatting */

function formatMins(mins) {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const modelled = (text) => `<span class="modelled">~${text}<em>modelled</em></span>`;

/* ------------------------------------------------------------------ routing */

async function fetchDurations(accident, targets) {
  const coords = [accident, ...targets].map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${OSRM_BASE}/table/v1/driving/${coords}?sources=0&annotations=duration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('No drive times available');
  return data.durations[0].slice(1);
}

async function fetchRoute(from, to) {
  const url = `${OSRM_BASE}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No drivable route found');
  return data.routes[0];
}

/* -------------------------------------------------------------------- render */

function selection() {
  return {
    monthKey: monthSelect.value,
    monthLabel: monthSelect.options[monthSelect.selectedIndex]?.textContent ?? '',
    day: Number(daySelect.value),
    hour: Number(hourSelect.value)
  };
}

function renderResults({ accident, nearest, best, sel, status, error }) {
  const site = accident.label || `${accident.lat.toFixed(4)}, ${accident.lng.toFixed(4)}`;

  if (error) {
    resultsBody.className = '';
    resultsBody.innerHTML =
      `<p class="hospital-name">${nearest.name}</p>` +
      `<div class="row"><span class="k">Accident site</span><span class="v">${site}</span></div>` +
      `<div class="row"><span class="k">Straight-line</span><span class="v">${nearest.straightKm.toFixed(2)} km</span></div>` +
      `<p class="status error">${error}</p>`;
    return;
  }

  if (status) {
    resultsBody.className = '';
    resultsBody.innerHTML =
      `<p class="hospital-name">${nearest.name}</p>` +
      `<div class="row"><span class="k">Accident site</span><span class="v">${site}</span></div>` +
      `<p class="status">${status}</p>`;
    return;
  }

  const card = (h, kind) => {
    const w = h.wait;
    const rows = [
      ['Drive time', formatMins(h.driveMin)],
      ['Straight-line', `${h.straightKm.toFixed(2)} km`]
    ];
    if (w) {
      rows.push(['Time in A&E', modelled(`${formatMins(w.p25Min)} – ${formatMins(w.p75Min)}`)]);
      rows.push(['4hr breaches', `${(w.breachRate * 100).toFixed(1)}% of Type 1`]);
    } else {
      rows.push(['Time in A&E', '<span class="muted">no NHS data</span>']);
    }
    return (
      `<div class="card ${kind}">` +
      `<p class="card-label">${kind === 'best' ? 'Fastest to treatment' : 'Nearest A&amp;E'}</p>` +
      `<p class="hospital-name">${h.name}</p>` +
      (h.total != null
        ? `<div class="eta">${modelled(formatMins(h.total))}<small>door to treated</small></div>`
        : '') +
      rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
      `</div>`
    );
  };

  let html =
    `<div class="row site"><span class="k">Accident</span><span class="v">${site}</span></div>` +
    `<div class="row site"><span class="k">When</span><span class="v">${sel.monthLabel}, ${curve.dayOrder[sel.day]} ${String(sel.hour).padStart(2, '0')}:00</span></div>`;

  html += card(nearest, 'nearest');

  const saved = best && nearest.total != null ? nearest.total - best.total : 0;

  if (best && best.name !== nearest.name && saved >= MIN_SAVING_MIN) {
    html +=
      `<p class="verdict">Sending the ambulance ${formatMins(best.driveMin - nearest.driveMin)} further ` +
      `to <strong>${best.name}</strong> gets this patient treated about ` +
      `<strong>${formatMins(saved)}</strong> sooner.</p>` +
      card(best, 'best');
  } else if (best && best.name !== nearest.name) {
    html +=
      `<p class="verdict ok">Go to the nearest. ${best.name} models ` +
      `${formatMins(saved)} quicker overall — too small to justify the extra distance, ` +
      `and well inside the model's margin of error.</p>`;
  } else if (best) {
    html += `<p class="verdict ok">The nearest A&amp;E is also the fastest to treatment here.</p>`;
  }

  resultsBody.className = '';
  resultsBody.innerHTML = html;
}

function renderCandidates(list) {
  candidatesList.innerHTML = list
    .map(
      (h) =>
        `<li><span>${h.name}</span><span class="cand-v">${formatMins(h.driveMin)} drive · ` +
        `${h.total != null ? '~' + formatMins(h.total) : '—'} total</span></li>`
    )
    .join('');
  candidatesBlock.hidden = false;
}

/* ------------------------------------------------------------------ dispatch */

function drawRoute(latlngs, { muted } = {}) {
  L.polyline(latlngs, { color: '#1b2a3a', weight: muted ? 5 : 8, opacity: 0.3 }).addTo(dispatchLayer);
  L.polyline(latlngs, {
    color: muted ? '#8ea3b8' : '#3aa0ff',
    weight: muted ? 3 : 4,
    opacity: muted ? 0.8 : 0.95,
    dashArray: muted ? '6 6' : null
  }).addTo(dispatchLayer);
}

async function dispatch(accident) {
  lastAccident = accident;
  const token = ++requestToken;
  const sel = selection();
  const ranked = rankHospitals(accident);
  if (!ranked.length) return;

  const nearest = ranked[0];

  dispatchLayer.clearLayers();
  L.marker([accident.lat, accident.lng], { icon: dotIcon('#ff4d4d', 16) })
    .bindPopup(`<strong>Accident</strong><br>${accident.label || 'Selected point'}`)
    .addTo(dispatchLayer);

  renderResults({ accident, nearest, sel, status: 'Calculating drive times…' });

  const candidates = ranked.slice(0, CANDIDATE_COUNT);

  try {
    const durations = await fetchDurations(accident, candidates);
    if (token !== requestToken) return;

    candidates.forEach((h, i) => {
      h.driveMin = durations[i] / 60;
      h.wait = estimateWait(h.orgCode, sel.monthKey, sel.day, sel.hour);
      h.total = h.wait ? h.driveMin + h.wait.medianMin : null;
    });

    const withTotal = candidates.filter((h) => h.total != null);
    const nearestC = candidates[0];
    const best = withTotal.length
      ? withTotal.reduce((a, b) => (b.total < a.total ? b : a))
      : null;

    renderResults({ accident, nearest: nearestC, best, sel });
    renderCandidates(
      candidates.filter((h) => h !== nearestC && h !== best).slice(0, 3)
    );

    const targets = best && best !== nearestC ? [nearestC, best] : [nearestC];
    L.marker([nearestC.lat, nearestC.lng], { icon: dotIcon('#2ecc71', 16) })
      .bindPopup(`<strong>${nearestC.name}</strong><br>Nearest major A&E`)
      .addTo(dispatchLayer);
    if (best && best !== nearestC) {
      L.marker([best.lat, best.lng], { icon: dotIcon('#3aa0ff', 16) })
        .bindPopup(`<strong>${best.name}</strong><br>Fastest to treatment`)
        .addTo(dispatchLayer);
    }

    const routes = await Promise.all(targets.map((t) => fetchRoute(accident, t).catch(() => null)));
    if (token !== requestToken) return;

    const allPoints = [[accident.lat, accident.lng]];
    routes.forEach((route, i) => {
      if (!route) return;
      const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      // When a better option exists it gets the solid line; the nearest is dashed.
      drawRoute(latlngs, { muted: targets.length > 1 && i === 0 });
      allPoints.push(...latlngs);
    });
    map.fitBounds(L.latLngBounds(allPoints).pad(0.15));
  } catch (err) {
    if (token !== requestToken) return;
    map.fitBounds(
      L.latLngBounds([[accident.lat, accident.lng], [nearest.lat, nearest.lng]]).pad(0.25)
    );
    renderResults({ accident, nearest, sel, error: `Routing unavailable: ${err.message}` });
  }
}

/* ---------------------------------------------------------------------- init */

function drawHospitals() {
  hospitals.forEach((h) => {
    const major = h.aeType === 1;
    L.marker([h.lat, h.lng], { icon: dotIcon(major ? '#2ecc71' : '#6d8095', major ? 9 : 7) })
      .bindPopup(
        `<strong>${h.name}</strong><br>${major ? 'Type 1 — major A&E' : 'Type 3 — urgent care only'}` +
        (h.siteNote ? `<br><em>${h.siteNote}</em>` : '')
      )
      .addTo(hospitalLayer);
  });
}

function drawHotspots() {
  hotspotLayer.clearLayers();
  hotspots.forEach((s) => {
    L.marker([s.lat, s.lng], { icon: dotIcon('#f5a623', 10) })
      .bindPopup(`<strong>${s.name}</strong><br>Accident hotspot`)
      .on('click', () => dispatch({ lat: s.lat, lng: s.lng, label: s.name }))
      .addTo(hotspotLayer);
  });
}

function populateControls() {
  hotspots.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = s.name;
    hotspotSelect.appendChild(opt);
  });

  nhs.periods
    .slice()
    .reverse()
    .forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      monthSelect.appendChild(opt);
    });

  curve.dayOrder.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i];
    daySelect.appendChild(opt);
  });
  daySelect.value = '6'; // Saturday — a realistic peak-trauma default

  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${String(h).padStart(2, '0')}:00`;
    hourSelect.appendChild(opt);
  }
  hourSelect.value = '20';

  const assumed = curve.source !== 'provider';
  methodNote.innerHTML =
    `<strong>Measured:</strong> drive times (OSRM road network) and A&amp;E four-hour breach rates ` +
    `(NHS England monthly MSitAE, ${nhs.periods[0].label}–${nhs.periods.at(-1).label}, Open Government Licence).<br>` +
    `<strong>Modelled (<em>~</em>):</strong> time in A&amp;E is inferred from the published breach rate, ` +
    `not looked up — per-patient waits are not public (NHS Digital ECDS requires a DARS application).<br>` +
    (assumed
      ? `<strong>Assumption:</strong> the hour-of-day demand curve is <em>not</em> NHS-sourced. ` +
        `NHS Digital blocks automated access, so a documented assumed curve is used.<br>`
      : '') +
    `<strong>Granularity:</strong> NHS figures are trust-level, so sites in the same trust share a ` +
    `figure (e.g. St Thomas' and Guy's are both RJ1).`;
}

[monthSelect, daySelect, hourSelect].forEach((el) =>
  el.addEventListener('change', () => {
    if (lastAccident) dispatch(lastAccident);
  })
);

hotspotSelect.addEventListener('change', () => {
  const s = hotspots[Number(hotspotSelect.value)];
  if (s) dispatch({ lat: s.lat, lng: s.lng, label: s.name });
});

toggleHotspots.addEventListener('change', () => {
  if (toggleHotspots.checked) hotspotLayer.addTo(map);
  else map.removeLayer(hotspotLayer);
});

map.on('click', (e) => {
  hotspotSelect.value = '';
  dispatch({ lat: e.latlng.lat, lng: e.latlng.lng });
});

async function init() {
  try {
    const [h, s, t, c] = await Promise.all([
      fetch('hospitals.json').then((r) => r.json()),
      fetch('hotspots.json').then((r) => r.json()),
      fetch('data/nhs-trusts.json').then((r) => r.json()),
      fetch('data/arrival-curve.json').then((r) => r.json())
    ]);
    hospitals = h;
    hotspots = s;
    nhs = t;
    curve = c;
    drawHospitals();
    drawHotspots();
    populateControls();
  } catch (err) {
    resultsBody.className = '';
    resultsBody.innerHTML = `<p class="status error">Failed to load data: ${err.message}. Serve this over http:// rather than opening the file directly.</p>`;
  }
}

init();
