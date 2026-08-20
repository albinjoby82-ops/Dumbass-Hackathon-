import { AlertService } from './src/alerts.js';
import { CapacityService } from './src/capacity.js';

const $ = (id) => document.getElementById(id);
const alerts = new AlertService();
let capacity = null;
let hospitals = [];
let mine = null; // { name, orgCode }

const STORE_KEY = 'rapidcare-console-site';

function timeAgo(iso) {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.round(secs)}s ago`;
  return `${Math.round(secs / 60)} min ago`;
}

/** Case refs already on screen, so a genuinely new arrival can announce itself. */
let seen = new Set();
let firstRender = true;

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function render() {
  const list = alerts.all().filter((a) => !mine || a.orgCode === mine.orgCode);
  const el = $('alerts');

  const pending = list.filter((a) => a.status !== 'acknowledged').length;
  const count = $('alert-count');
  count.textContent = String(pending);
  count.hidden = pending === 0;

  const arrivals = list.filter((a) => !seen.has(a.caseRef));
  if (!firstRender && arrivals.length) {
    toast(`New pre-alert — ${arrivals[0].pathway}`);
  }

  if (!list.length) {
    el.innerHTML = `<p class="empty">No incoming pre-alerts for ${mine ? mine.name : 'this hospital'}.</p>`;
    seen = new Set();
    firstRender = false;
    return;
  }

  el.innerHTML = list
    .map((a) => {
      const acked = a.status === 'acknowledged';
      const fresh = !firstRender && !seen.has(a.caseRef);
      return `
        <div class="alert ${acked ? 'acked' : ''}${fresh ? ' fresh' : ''}">
          <div class="alert-head">
            <span class="case-ref">${a.caseRef}</span>
            <span class="ago">${timeAgo(a.sentAt)}</span>
          </div>
          <p class="alert-pathway">${a.pathway}</p>
          <div class="row"><span class="k">ETA</span><span class="v">${a.etaText}</span></div>
          <div class="row"><span class="k">Patient</span><span class="v">${a.patientSummary}</span></div>
          <div class="row"><span class="k">From</span><span class="v">${a.origin}</span></div>
          ${a.conditionNotes.length
            ? `<ul class="reasons">${a.conditionNotes.map((n) => `<li>${n}</li>`).join('')}</ul>`
            : ''}
          <div class="alert-actions">
            ${acked
              ? `<span class="acked-tag">Acknowledged</span>`
              : `<button data-ack="${a.caseRef}">Acknowledge</button>`}
          </div>
        </div>`;
    })
    .join('');

  el.querySelectorAll('[data-ack]').forEach((b) =>
    b.addEventListener('click', () => alerts.setStatus(b.dataset.ack, 'acknowledged'))
  );

  seen = new Set(list.map((a) => a.caseRef));
  firstRender = false;
}

function selectSite(name) {
  const h = hospitals.find((x) => x.name === name) || hospitals[0];
  mine = { name: h.name, orgCode: h.orgCode };
  // Switching sites reveals that site's existing alerts — they are not new arrivals,
  // so suppress the announcement for this render.
  firstRender = true;
  localStorage.setItem(STORE_KEY, h.name);
  $('own-status').value = capacity.overrides[h.orgCode] || 'normal';
  render();
}

async function init() {
  const [h, nhs, curve] = await Promise.all([
    fetch('hospitals.json').then((r) => r.json()),
    fetch('data/nhs-trusts.json').then((r) => r.json()),
    fetch('data/arrival-curve.json').then((r) => r.json())
  ]);
  hospitals = h;
  capacity = new CapacityService(nhs, curve);

  const picker = $('hospital-picker');
  hospitals.forEach((x) => {
    const o = document.createElement('option');
    o.value = x.name;
    o.textContent = x.name;
    picker.appendChild(o);
  });

  const saved = localStorage.getItem(STORE_KEY);
  picker.value = saved && hospitals.some((x) => x.name === saved) ? saved : hospitals[0].name;
  selectSite(picker.value);

  picker.addEventListener('change', () => selectSite(picker.value));
  $('own-status').addEventListener('change', () =>
    capacity.setStatus(mine.orgCode, $('own-status').value)
  );

  capacity.onChange(() => {
    if (mine) $('own-status').value = capacity.overrides[mine.orgCode] || 'normal';
  });
  alerts.onChange(render);
  setInterval(render, 15000); // keep the "x min ago" stamps honest
}

init().catch((err) => {
  $('alerts').innerHTML = `<p class="status error">Failed to load: ${err.message}. Serve over http://.</p>`;
});
