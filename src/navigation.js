/**
 * Turn-by-turn navigation progress along an OSRM route.
 *
 * Pure geometry + progress maths, deliberately independent of the DOM and of Leaflet so
 * it can be reasoned about (and tested) on its own. The view layer asks it "given that I
 * am this far along, what should I show?".
 *
 * Position can be driven by real GPS or by the simulator, which matters because a demo
 * indoors cannot actually drive the route.
 */

const R = 6371000; // metres

export function metresBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Human distance: metres under 1 km, then kilometres. */
export function formatDistance(m) {
  if (m < 10) return 'now';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

const MANEUVER_ICON = {
  depart: '↑',
  arrive: '⚑',
  'turn-left': '↰',
  'turn-right': '↱',
  'turn-sharp left': '↰',
  'turn-sharp right': '↱',
  'turn-slight left': '↖',
  'turn-slight right': '↗',
  'turn-straight': '↑',
  'turn-uturn': '↺',
  continue: '↑',
  'new name': '↑',
  merge: '⤳',
  roundabout: '↻',
  rotary: '↻',
  fork: '⑂',
  'end of road': '↱'
};

export function maneuverIcon(step) {
  const m = step?.maneuver;
  if (!m) return '↑';
  if (m.type === 'turn' || m.type === 'end of road' || m.type === 'fork') {
    return MANEUVER_ICON[`turn-${m.modifier || 'straight'}`] || '↑';
  }
  return MANEUVER_ICON[m.type] || '↑';
}

export function instructionText(step) {
  const m = step?.maneuver;
  if (!m) return 'Continue';
  const road = step.name && step.name.length ? step.name : null;
  const mod = m.modifier || '';
  switch (m.type) {
    case 'depart': return road ? `Head out on ${road}` : 'Head out';
    case 'arrive': return 'Arrive at destination';
    case 'turn': return road ? `Turn ${mod} onto ${road}` : `Turn ${mod}`;
    case 'end of road': return road ? `Turn ${mod} onto ${road}` : `Turn ${mod}`;
    case 'fork': return road ? `Keep ${mod} onto ${road}` : `Keep ${mod}`;
    case 'merge': return road ? `Merge onto ${road}` : `Merge ${mod}`;
    case 'roundabout':
    case 'rotary':
      return `At the roundabout take exit ${m.exit || ''}`.trim() + (road ? ` onto ${road}` : '');
    case 'new name':
    case 'continue':
      return road ? `Continue onto ${road}` : 'Continue';
    default:
      return road ? `${m.type} onto ${road}` : m.type;
  }
}

/**
 * Wraps an OSRM route with cumulative distances so progress can be resolved to a
 * position, an upcoming maneuver, and remaining distance/time.
 */
export class RouteProgress {
  constructor(route) {
    this.route = route;
    this.points = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng, cum: 0 }));
    for (let i = 1; i < this.points.length; i++) {
      this.points[i].cum = this.points[i - 1].cum + metresBetween(this.points[i - 1], this.points[i]);
    }
    this.totalM = this.points.at(-1)?.cum ?? 0;
    this.totalSec = route.duration;

    // Anchor each step to a distance along the route via its maneuver location.
    const steps = route.legs?.[0]?.steps ?? [];
    this.steps = steps.map((s) => {
      const loc = { lng: s.maneuver.location[0], lat: s.maneuver.location[1] };
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const d = metresBetween(loc, this.points[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      return { step: s, cum: this.points[best].cum };
    });
  }

  /** Interpolated position at `d` metres along the route. */
  positionAt(d) {
    const p = this.points;
    if (!p.length) return null;
    if (d <= 0) return { lat: p[0].lat, lng: p[0].lng };
    if (d >= this.totalM) return { lat: p.at(-1).lat, lng: p.at(-1).lng };

    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].cum <= d) lo = mid; else hi = mid;
    }
    const span = p[hi].cum - p[lo].cum || 1;
    const t = (d - p[lo].cum) / span;
    return {
      lat: p[lo].lat + (p[hi].lat - p[lo].lat) * t,
      lng: p[lo].lng + (p[hi].lng - p[lo].lng) * t
    };
  }

  /** Compass bearing at `d`, so the vehicle marker can point the right way. */
  bearingAt(d) {
    const a = this.positionAt(Math.max(0, d - 12));
    const b = this.positionAt(Math.min(this.totalM, d + 12));
    if (!a || !b) return 0;
    const toRad = (x) => (x * Math.PI) / 180;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x =
      Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  /** Snap an arbitrary GPS fix onto the route, returning metres travelled. */
  snap(pos) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = metresBetween(pos, this.points[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { distanceAlong: this.points[best].cum, offRouteM: bestD };
  }

  /** Everything the navigation view needs for a given progress distance. */
  stateAt(d) {
    const clamped = Math.max(0, Math.min(this.totalM, d));
    const upcoming = this.steps.find((s) => s.cum > clamped + 5) ?? this.steps.at(-1);
    const idx = this.steps.indexOf(upcoming);
    const remainingM = Math.max(0, this.totalM - clamped);
    const fraction = this.totalM ? remainingM / this.totalM : 0;

    return {
      position: this.positionAt(clamped),
      bearing: this.bearingAt(clamped),
      distanceAlong: clamped,
      remainingM,
      remainingSec: this.totalSec * fraction,
      arrived: remainingM < 25,
      step: upcoming?.step ?? null,
      nextStep: idx >= 0 ? this.steps[idx + 1]?.step ?? null : null,
      distanceToManeuver: upcoming ? Math.max(0, upcoming.cum - clamped) : 0
    };
  }
}

/**
 * Drives progress forward for a demo. `speedFactor` multiplies real time, so a 12-minute
 * journey can be watched in under a minute.
 */
export class DriveSimulator {
  constructor(progress, { speedFactor = 14, onTick } = {}) {
    this.progress = progress;
    this.speedFactor = speedFactor;
    this.onTick = onTick;
    this.distance = 0;
    this.timer = null;
    // Average speed implied by the route itself, so slow roads stay slow.
    this.metresPerSec = progress.totalSec ? progress.totalM / progress.totalSec : 8;
  }

  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      this.distance += this.metresPerSec * this.speedFactor * dt;
      const state = this.progress.stateAt(this.distance);
      this.onTick?.(state);
      if (state.arrived) this.stop();
    }, 200);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }
}
