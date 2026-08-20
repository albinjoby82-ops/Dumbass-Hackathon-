/* London Ambulance Nearest-Hospital Router — MVP + driver front-end */

const LONDON_CENTER = [51.5074, -0.1278];
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

const state = {
  facilitiesDb: null,
  hotspots: [],
  ambulanceLatLng: null,
  accidentLatLng: null,
  nearestHospital: null,
  selectedService: "ED",
  follow: false,
  watchId: null,
};

const markers = {
  ambulance: null,
  accident: null,
  hospital: null,
  hospitalPins: [],
};

const layers = {
  toAccident: null,
  toHospital: null,
};

// ---------- Map init ----------
const map = L.map("map", { zoomControl: true }).setView(LONDON_CENTER, 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

function emojiIcon(emoji, size = 28) {
  return L.divIcon({
    html: `<div style="font-size:${size}px; line-height:1; transform: translate(-50%, -50%);">${emoji}</div>`,
    className: "emoji-marker",
    iconSize: [0, 0],
  });
}

const ICONS = {
  ambulance: emojiIcon("🚑", 30),
  accident: emojiIcon("🚧", 28),
  hospital: emojiIcon("🏥", 30),
  hospitalPin: emojiIcon("➕", 16),
};

// ---------- Data loading ----------
Promise.all([fetch("hotspots.json").then((r) => r.json()), FacilitiesDB.load()])
  .then(([hotspots, facilitiesDb]) => {
    state.hotspots = hotspots;
    state.facilitiesDb = facilitiesDb;
    // Public read-only query entry point for UI features and browser-console use.
    window.facilitiesDb = facilitiesDb;
    renderServiceSelect();
    renderHospitalPins();
    renderHotspotList();
  })
  .catch((err) => {
    document.getElementById("hotspotList").innerHTML =
      '<p class="hint">Failed to load data files. Serve this folder over http:// (e.g. `npx serve`), not file://.</p>';
    console.error(err);
  });

function renderServiceSelect() {
  const codes = state.facilitiesDb.metadata.service_codes;
  const select = document.getElementById("serviceSelect");
  select.innerHTML = "";
  const edFirst = ["ED", ...Object.keys(codes).filter((c) => c !== "ED")];
  edFirst.forEach((code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code} — ${codes[code]}`;
    select.appendChild(opt);
  });
  select.value = state.selectedService;

  document.getElementById("clinicalSafetyNote").textContent =
    `⚠ ${state.facilitiesDb.metadata.clinical_safety}`;

  select.addEventListener("change", () => {
    state.selectedService = select.value;
    if (state.accidentLatLng) {
      setAccident(state.accidentLatLng.lat, state.accidentLatLng.lng);
    }
  });
}

function renderHospitalPins() {
  state.facilitiesDb.facilities.forEach((f) => {
    const m = L.marker([f.lat, f.lng], { icon: ICONS.hospitalPin, opacity: 0.8 }).addTo(map);
    m.bindTooltip(`${f.name} — ${f.services.join(", ")}`, { className: "marker-label" });
    markers.hospitalPins.push(m);
  });
}

function renderHotspotList() {
  const container = document.getElementById("hotspotList");
  container.innerHTML = "";
  state.hotspots.forEach((spot) => {
    const btn = document.createElement("button");
    btn.className = "hotspot-btn";
    btn.textContent = `📍 ${spot.name}`;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".hotspot-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setAccident(spot.lat, spot.lng);
      map.setView([spot.lat, spot.lng], 14);
    });
    container.appendChild(btn);
  });
}

// ---------- Map click = drop accident marker ----------
map.on("click", (e) => {
  document.querySelectorAll(".hotspot-btn").forEach((b) => b.classList.remove("active"));
  setAccident(e.latlng.lat, e.latlng.lng);
});

// ---------- Nearest facility lookup ----------
function nearestHospital(point) {
  const urgentService = ["URGENT", "UTC", "MIU", "WIC"].includes(state.selectedService);
  const results = state.facilitiesDb.nearest(point.lat, point.lng, {
    service: state.selectedService,
    limit: 4,
    ...(urgentService ? { openAt: new Date(), walkInOnly: true } : {}),
  });
  if (!results.length) return { hospital: null, distanceKm: null, alternates: [] };
  const [hospital, ...alternates] = results;
  return { hospital, distanceKm: hospital.distanceKm, alternates };
}

// ---------- Setting accident / ambulance ----------
function setAccident(lat, lng) {
  state.accidentLatLng = { lat, lng };

  if (markers.accident) map.removeLayer(markers.accident);
  markers.accident = L.marker([lat, lng], { icon: ICONS.accident }).addTo(map);
  markers.accident.bindTooltip("Accident scene", { className: "marker-label", permanent: false });

  document.getElementById("accidentStatus").textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const { hospital, distanceKm, alternates } = nearestHospital(state.accidentLatLng);
  state.nearestHospital = hospital;

  const metaEl = document.getElementById("hospitalMeta");
  const altEl = document.getElementById("alternatesList");

  if (!hospital) {
    if (markers.hospital) map.removeLayer(markers.hospital);
    document.getElementById("hospitalStatus").textContent = "None found";
    document.getElementById("straightLineNote").textContent =
      `No facility offers ${state.selectedService} in this dataset.`;
    metaEl.innerHTML = "";
    altEl.innerHTML = "";
    recalcRoutes();
    return;
  }

  if (markers.hospital) map.removeLayer(markers.hospital);
  markers.hospital = L.marker([hospital.lat, hospital.lng], { icon: ICONS.hospital }).addTo(map);
  markers.hospital.bindTooltip(hospital.name, { className: "marker-label" });

  const urgent = hospital.urgentCare;
  document.getElementById("hospitalStatus").textContent = urgent
    ? `${hospital.name} · ${urgent.hoursLabel}`
    : hospital.name;
  document.getElementById("straightLineNote").textContent =
    `Demo result · straight-line distance: ${distanceKm.toFixed(2)} km`;

  metaEl.innerHTML = `
    <div class="meta-address">${hospital.address}, ${hospital.postcode} — ${hospital.borough}</div>
    <div class="meta-services">${hospital.services.map((s) => `<span class="service-chip">${s}</span>`).join("")}</div>
  `;

  altEl.innerHTML = alternates
    .map((h) => `<li>${h.name} — ${h.distanceKm.toFixed(2)} km</li>`)
    .join("");

  recalcRoutes();
}

function setAmbulance(lat, lng) {
  state.ambulanceLatLng = { lat, lng };

  if (markers.ambulance) map.removeLayer(markers.ambulance);
  markers.ambulance = L.marker([lat, lng], { icon: ICONS.ambulance }).addTo(map);
  markers.ambulance.bindTooltip("Ambulance", { className: "marker-label" });

  document.getElementById("ambulanceStatus").textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  recalcRoutes();
}

// ---------- OSRM routing ----------
async function fetchRoute(a, b) {
  const url = `${OSRM_BASE}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM error ${res.status}`);
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error("No route found");
  return data.routes[0];
}

function formatDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(2)} km`;
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
  const base = typeMap[m.type] || m.type;
  return `${base}${road}`;
}

async function recalcRoutes() {
  clearRouteLayers();
  const directionsList = document.getElementById("directionsList");
  directionsList.innerHTML = "";

  const legToAccidentEl = document.querySelector("#legToAccident .metric-eta");
  const legToAccidentDist = document.querySelector("#legToAccident .metric-dist");
  const legToHospitalEl = document.querySelector("#legToHospital .metric-eta");
  const legToHospitalDist = document.querySelector("#legToHospital .metric-dist");

  let anySteps = false;

  // Leg 1: ambulance -> accident
  if (state.ambulanceLatLng && state.accidentLatLng) {
    try {
      const route = await fetchRoute(state.ambulanceLatLng, state.accidentLatLng);
      legToAccidentEl.textContent = formatDuration(route.duration);
      legToAccidentDist.textContent = formatDistance(route.distance);
      layers.toAccident = L.geoJSON(route.geometry, {
        style: { color: "#4fa8ff", weight: 5, opacity: 0.85, dashArray: "2 8" },
      }).addTo(map);

      addDirectionsHeader("🚑 → 🚧 To accident scene");
      route.legs[0].steps.forEach((step, i) => addDirectionStep(i + 1, step));
      anySteps = true;
    } catch (err) {
      legToAccidentEl.textContent = "Route unavailable";
      legToAccidentDist.textContent = "";
      console.error(err);
    }
  } else {
    legToAccidentEl.textContent = "—";
    legToAccidentDist.textContent = state.ambulanceLatLng ? "" : "Set ambulance location";
  }

  // Leg 2: accident -> hospital
  if (state.accidentLatLng && state.nearestHospital) {
    try {
      const route = await fetchRoute(state.accidentLatLng, state.nearestHospital);
      legToHospitalEl.textContent = formatDuration(route.duration);
      legToHospitalDist.textContent = formatDistance(route.distance);
      layers.toHospital = L.geoJSON(route.geometry, {
        style: { color: "#ff5a5f", weight: 5, opacity: 0.9 },
      }).addTo(map);

      addDirectionsHeader("🚧 → 🏥 To hospital");
      route.legs[0].steps.forEach((step, i) => addDirectionStep(i + 1, step));
      anySteps = true;

      const bounds = L.latLngBounds([
        [state.accidentLatLng.lat, state.accidentLatLng.lng],
        [state.nearestHospital.lat, state.nearestHospital.lng],
      ]);
      if (state.ambulanceLatLng) bounds.extend([state.ambulanceLatLng.lat, state.ambulanceLatLng.lng]);
      map.fitBounds(bounds, { padding: [60, 60] });
    } catch (err) {
      legToHospitalEl.textContent = "Route unavailable";
      legToHospitalDist.textContent = "";
      console.error(err);
    }
  } else {
    legToHospitalEl.textContent = "—";
    legToHospitalDist.textContent = "";
  }

  if (!anySteps) {
    directionsList.innerHTML = '<li class="hint">Directions will appear once a route is calculated.</li>';
  }
}

function addDirectionsHeader(text) {
  const li = document.createElement("li");
  li.className = "leg-divider";
  li.textContent = text;
  document.getElementById("directionsList").appendChild(li);
}

function addDirectionStep(idx, step) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.className = "step-idx";
  span.textContent = `${idx}.`;
  const text = document.createElement("span");
  text.textContent = `${stepInstruction(step)} — ${formatDistance(step.distance)}`;
  li.appendChild(span);
  li.appendChild(text);
  document.getElementById("directionsList").appendChild(li);
}

function clearRouteLayers() {
  if (layers.toAccident) {
    map.removeLayer(layers.toAccident);
    layers.toAccident = null;
  }
  if (layers.toHospital) {
    map.removeLayer(layers.toHospital);
    layers.toHospital = null;
  }
}

// ---------- Geolocation ----------
document.getElementById("locateBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setAmbulance(pos.coords.latitude, pos.coords.longitude);
      map.setView([pos.coords.latitude, pos.coords.longitude], 14);
    },
    (err) => {
      alert(`Could not get location: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

document.getElementById("followToggle").addEventListener("change", (e) => {
  state.follow = e.target.checked;
  if (state.follow) {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported in this browser.");
      e.target.checked = false;
      state.follow = false;
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setAmbulance(pos.coords.latitude, pos.coords.longitude);
        if (state.follow) map.panTo([pos.coords.latitude, pos.coords.longitude]);
      },
      (err) => console.error(err),
      { enableHighAccuracy: true }
    );
  } else if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
});

// ---------- Driver mode ----------
document.getElementById("driverModeToggle").addEventListener("change", (e) => {
  document.body.classList.toggle("driver-mode", e.target.checked);
});

// ---------- Mobile panel toggle ----------
document.getElementById("panelToggle").addEventListener("click", () => {
  document.getElementById("panel").classList.toggle("collapsed");
});
