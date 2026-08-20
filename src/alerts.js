/**
 * Pre-alert channel between the dispatcher view and the hospital console.
 *
 * SIMULATED COMMUNICATION. This does not contact any real hospital. It is a local
 * BroadcastChannel + localStorage bus so the two views in this demo talk to each other
 * with no backend. A real deployment would put an authenticated service here.
 */

const CHANNEL = 'rapidcare-alerts';
const MAX_KEPT = 40;

export class AlertService {
  constructor() {
    this.listeners = new Set();
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => this._emit();
    } catch {
      this.channel = null;
    }
    window.addEventListener('storage', (e) => {
      if (e.key === CHANNEL) this._emit();
    });
  }

  _emit() {
    this.listeners.forEach((fn) => fn(this.all()));
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

  _save(list) {
    localStorage.setItem(CHANNEL, JSON.stringify(list.slice(0, MAX_KEPT)));
    this.channel?.postMessage('changed');
    this._emit();
  }

  /** Dispatcher sends a pre-alert. Returns the case reference. */
  send(alert) {
    const caseRef = `LAS-${String(Date.now()).slice(-6)}`;
    const record = {
      caseRef,
      sentAt: new Date().toISOString(),
      status: 'sent',
      ...alert
    };
    this._save([record, ...this.all()]);
    return record;
  }

  /** Hospital acknowledges. */
  setStatus(caseRef, status) {
    this._save(this.all().map((a) => (a.caseRef === caseRef ? { ...a, status } : a)));
  }

  clear() {
    this._save([]);
  }
}
