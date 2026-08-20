/**
 * Incident channel between the dispatcher view and the driver console.
 *
 * SIMULATED COMMUNICATION. Same local bus as the pre-alert channel: BroadcastChannel plus
 * localStorage, so the two views in this demo hand work to each other with no backend.
 * A real deployment would put an authenticated CAD dispatch service here.
 *
 * Direction of travel:
 *   dispatcher  -> dispatch()          creates the job, status 'dispatched'
 *   driver      -> amend()             on-scene assessment overwrites the dispatched detail
 *   driver      -> setDestination()    hospital chosen, status 'en-route'
 *   driver      -> setStatus(...)      'arrived' / 'handover' / 'cancelled'
 */

const CHANNEL = 'rapidcare-incidents';
const MAX_KEPT = 30;

/** Statuses that still belong to a crew — anything else is history. */
const OPEN = new Set(['dispatched', 'on-scene', 'en-route', 'arrived']);

export class IncidentChannel {
  constructor() {
    this.listeners = new Set();
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => this._emit();
    } catch {
      this.channel = null; // BroadcastChannel unsupported — local-only still works
    }
    window.addEventListener('storage', (e) => {
      if (e.key === CHANNEL) this._emit();
    });
  }

  _emit() {
    const list = this.all();
    this.listeners.forEach((fn) => fn(list));
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all() {
    try {
      return JSON.parse(localStorage.getItem(CHANNEL) || '[]');
    } catch {
      return [];
    }
  }

  get(caseRef) {
    return this.all().find((i) => i.caseRef === caseRef) || null;
  }

  /** Most recent job a crew has not finished with. */
  latestOpen() {
    return this.all().find((i) => OPEN.has(i.status)) || null;
  }

  _save(list) {
    localStorage.setItem(CHANNEL, JSON.stringify(list.slice(0, MAX_KEPT)));
    this.channel?.postMessage('changed');
    this._emit();
  }

  /**
   * Dispatcher creates the job. `incident` carries everything the crew needs preloaded:
   * location, the dispatcher's severity/injury read, condition notes and the recommended
   * destination. Returns the stored record, including its case reference.
   */
  dispatch(incident) {
    const caseRef = `DUB-${String(Date.now()).slice(-6)}`;
    const record = {
      caseRef,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'dispatched',
      amended: false,
      amendments: [],
      ...incident
    };
    this._save([record, ...this.all()]);
    return record;
  }

  _patch(caseRef, patch) {
    let updated = null;
    this._save(
      this.all().map((i) => {
        if (i.caseRef !== caseRef) return i;
        updated = { ...i, ...patch, updatedAt: new Date().toISOString() };
        return updated;
      })
    );
    return updated;
  }

  /**
   * Crew's on-scene assessment. `amendments` is a list of human-readable changes
   * ("Severity: Serious -> Critical") so the dispatcher can see what the crew corrected.
   */
  amend(caseRef, { location, severity, injuryType, amendments, crewNote }) {
    const current = this.get(caseRef);
    if (!current) return null;
    return this._patch(caseRef, {
      location: location ?? current.location,
      severity: severity ?? current.severity,
      injuryType: injuryType ?? current.injuryType,
      crewNote: crewNote ?? current.crewNote,
      amendments: amendments ?? current.amendments,
      amended: (amendments ?? current.amendments ?? []).length > 0,
      status: current.status === 'dispatched' ? 'on-scene' : current.status
    });
  }

  /** Crew selected a destination and started driving. */
  setDestination(caseRef, { name, orgCode, etaText }) {
    return this._patch(caseRef, {
      destination: { name, orgCode, etaText },
      status: 'en-route'
    });
  }

  setStatus(caseRef, status) {
    return this._patch(caseRef, { status });
  }

  clear() {
    this._save([]);
  }
}
