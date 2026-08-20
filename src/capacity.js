/**
 * Operational capacity layer.
 *
 * SIMULATED. There is no public real-time feed for ED bed state, ambulance queues or
 * divert status in Dublin. The hackathon simulation uses illustrative hospital-level
 * baselines; none of the live-looking numbers are HSE measurements.
 *
 * The spec's computer-vision camera counts would feed exactly this interface. Replacing
 * `simulateState` with a real feed is the only change that would be needed.
 */

const CHANNEL = 'rapidcare-capacity';

export const STATUS = {
  normal: { label: 'Normal', penalty: 0, rank: 0 },
  pressure: { label: 'Under pressure', penalty: 0.35, rank: 1 },
  divert: { label: 'On divert', penalty: 1, rank: 2 }
};

/** Deterministic hash so simulated values are stable, not flickering on every render. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export class CapacityService {
  constructor(nhs, curve) {
    this.nhs = nhs;
    this.curve = curve;
    this.overrides = this._load();
    this.listeners = new Set();

    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => {
        this.overrides = e.data || {};
        this._emit();
      };
    } catch {
      this.channel = null; // BroadcastChannel unsupported — local-only still works
    }

    window.addEventListener('storage', (e) => {
      if (e.key === CHANNEL) {
        this.overrides = this._load();
        this._emit();
      }
    });
  }

  _load() {
    try {
      return JSON.parse(localStorage.getItem(CHANNEL) || '{}');
    } catch {
      return {};
    }
  }

  _emit() {
    this.listeners.forEach((fn) => fn());
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStatus(orgCode, status) {
    if (status === 'normal') delete this.overrides[orgCode];
    else this.overrides[orgCode] = status;
    localStorage.setItem(CHANNEL, JSON.stringify(this.overrides));
    this.channel?.postMessage(this.overrides);
    this._emit();
  }

  clearAll() {
    this.overrides = {};
    localStorage.setItem(CHANNEL, '{}');
    this.channel?.postMessage({});
    this._emit();
  }

  /** Illustrative demo baseline for the selected hospital and month. */
  breachRate(orgCode, monthKey) {
    return this.nhs?.trusts?.[orgCode]?.months?.[monthKey]?.type1BreachRate ?? null;
  }

  /**
   * SIMULATED live state. Queue depth scales with the illustrative baseline and the
   * hour-of-day demand factor, so a genuinely pressured trust simulates as busier.
   */
  simulateState(orgCode, monthKey, day, hour) {
    const breach = this.breachRate(orgCode, monthKey);
    const demand = this.curve?.matrix?.[day]?.[hour] ?? 1;
    const jitter = hash(`${orgCode}:${day}:${hour}`);

    const base = breach == null ? 0.3 : breach;
    const load = Math.min(1, base * demand * (0.75 + 0.5 * jitter));

    const status = this.overrides[orgCode] || 'normal';

    return {
      orgCode,
      simulated: true,
      breachRate: breach,
      demand,
      load,
      ambulancesWaiting: Math.round(load * 9),
      status,
      statusLabel: STATUS[status].label,
      overridden: Boolean(this.overrides[orgCode])
    };
  }

  /** 0 (clear) … 1 (worst). Divert forces the maximum. */
  penalty(state) {
    return Math.min(1, state.load * 0.7 + STATUS[state.status].penalty);
  }
}
