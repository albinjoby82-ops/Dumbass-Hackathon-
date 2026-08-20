const LONDON_CENTER = [51.5074, -0.1278];
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

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

let hospitals = [];
let hotspots = [];
let requestToken = 0;

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

function rankHospitals(accident) {
  return hospitals
    .map((h) => ({ ...h, straightKm: haversineKm(accident, h) }))
    .sort((a, b) => a.straightKm - b.straightKm);
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function fetchRoute(from, to) {
  const url = `${OSRM_BASE}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error('No drivable route found');
  }
  return data.routes[0];
}

function renderResults({ accident, hospital, route, status, error }) {
  const rows = [
    ['Accident site', accident.label || `${accident.lat.toFixed(4)}, ${accident.lng.toFixed(4)}`],
    ['Straight-line', `${hospital.straightKm.toFixed(2)} km`]
  ];

  let etaHtml = '';
  if (route) {
    rows.push(['Road distance', `${(route.distance / 1000).toFixed(2)} km`]);
    etaHtml = `<div class="eta">${formatDuration(route.duration)}<small>estimated drive</small></div>`;
  }

  const statusHtml = error
    ? `<p class="status error">${error}</p>`
    : status
      ? `<p class="status">${status}</p>`
      : '';

  resultsBody.className = '';
  resultsBody.innerHTML =
    `<p class="hospital-name">${hospital.name}</p>` +
    etaHtml +
    rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
    statusHtml;
}

function renderCandidates(ranked) {
  candidatesList.innerHTML = ranked
    .slice(1, 4)
    .map((h) => `<li>${h.name} — ${h.straightKm.toFixed(2)} km</li>`)
    .join('');
  candidatesBlock.hidden = false;
}

async function dispatch(accident) {
  const token = ++requestToken;
  const ranked = rankHospitals(accident);
  const nearest = ranked[0];

  dispatchLayer.clearLayers();
  L.marker([accident.lat, accident.lng], { icon: dotIcon('#ff4d4d', 16) })
    .bindPopup(`<strong>Accident</strong><br>${accident.label || 'Selected point'}`)
    .addTo(dispatchLayer);
  L.marker([nearest.lat, nearest.lng], { icon: dotIcon('#2ecc71', 16) })
    .bindPopup(`<strong>${nearest.name}</strong><br>Nearest hospital`)
    .addTo(dispatchLayer);

  renderResults({ accident, hospital: nearest, status: 'Calculating route…' });
  renderCandidates(ranked);

  try {
    const route = await fetchRoute(accident, nearest);
    if (token !== requestToken) return;

    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color: '#1b2a3a', weight: 8, opacity: 0.35 }).addTo(dispatchLayer);
    L.polyline(latlngs, { color: '#3aa0ff', weight: 4, opacity: 0.95 }).addTo(dispatchLayer);
    map.fitBounds(L.latLngBounds(latlngs).pad(0.15));

    renderResults({ accident, hospital: nearest, route });
  } catch (err) {
    if (token !== requestToken) return;
    map.fitBounds(
      L.latLngBounds([[accident.lat, accident.lng], [nearest.lat, nearest.lng]]).pad(0.25)
    );
    renderResults({ accident, hospital: nearest, error: `Route unavailable: ${err.message}` });
  }
}

function drawHospitals() {
  hospitals.forEach((h) => {
    L.marker([h.lat, h.lng], { icon: dotIcon('#2ecc71', 9) })
      .bindPopup(`<strong>${h.name}</strong><br>A&amp;E`)
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

function populateHotspotSelect() {
  hotspots.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = s.name;
    hotspotSelect.appendChild(opt);
  });
}

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
    const [h, s] = await Promise.all([
      fetch('hospitals.json').then((r) => r.json()),
      fetch('hotspots.json').then((r) => r.json())
    ]);
    hospitals = h;
    hotspots = s;
    drawHospitals();
    drawHotspots();
    populateHotspotSelect();
  } catch (err) {
    resultsBody.className = '';
    resultsBody.innerHTML = `<p class="status error">Failed to load data: ${err.message}. Serve this over http:// rather than opening the file directly.</p>`;
  }
}

init();
