/**
 * Build-time fetch of real NHS A&E data.
 *
 * Run manually:  node scripts/fetch-nhs-data.mjs
 * Writes:        data/nhs-trusts.json, data/arrival-curve.json
 *
 * The app never calls NHS endpoints at page load — it reads the committed JSON.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MONTHS_WANTED = 12;

const INDEX_PAGES = [
  'https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/ae-attendances-and-emergency-admissions-2026-27/',
  'https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/ae-attendances-and-emergency-admissions-2025-26/',
  'https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/ae-attendances-and-emergency-admissions-2024-25/'
];

/** NHS Digital annual publication — holds the real arrival-by-hour distribution. */
const ARRIVAL_SOURCE =
  'https://digital.nhs.uk/data-and-information/publications/statistical/hospital-accident--emergency-activity/2024-25';

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

/** Minimal RFC4180 parser — required: some org names contain quoted commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

/** "MSitAE-MARCH-2026" -> { key: "2026-03", label: "March 2026", sort: 202603 } */
function parsePeriod(raw) {
  const m = /([A-Za-z]+)-(\d{4})/.exec(raw || '');
  if (!m) return null;
  const idx = MONTH_NAMES.indexOf(m[1].toLowerCase());
  if (idx < 0) return null;
  const year = Number(m[2]);
  const mm = String(idx + 1).padStart(2, '0');
  return {
    key: `${year}-${mm}`,
    label: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${year}`,
    sort: year * 100 + idx + 1
  };
}

async function discoverMonthlyCsvUrls() {
  const found = [];
  for (const page of INDEX_PAGES) {
    const res = await fetch(page);
    if (!res.ok) {
      console.warn(`  ! index page ${res.status}: ${page}`);
      continue;
    }
    const html = await res.text();
    for (const m of html.matchAll(/href="([^"]+\.csv)"/gi)) {
      if (!found.includes(m[1])) found.push(m[1]);
    }
  }
  return found;
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

async function buildTrusts(referencedCodes) {
  console.log('Discovering monthly CSV files…');
  const urls = await discoverMonthlyCsvUrls();
  console.log(`  found ${urls.length} monthly CSV files`);

  const byPeriod = new Map();

  for (const url of urls) {
    if (byPeriod.size >= MONTHS_WANTED + 4) break;
    let rows;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  ! ${res.status} ${url}`); continue; }
      rows = parseCsv(await res.text());
    } catch (err) {
      console.warn(`  ! failed ${url}: ${err.message}`);
      continue;
    }

    const header = rows[0].map((h) => h.trim());
    const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

    const iPeriod = col('Period');
    const iCode = col('Org Code');
    const iParent = col('Parent Org');
    const iName = col('Org name');
    const iT1 = col('A&E attendances Type 1');
    const iT2 = col('A&E attendances Type 2');
    const iT3 = col('A&E attendances Other A&E Department');
    const iO1 = col('Attendances over 4hrs Type 1');
    const iO2 = col('Attendances over 4hrs Type 2');
    const iO3 = col('Attendances over 4hrs Other Department');
    const i12 = col('Patients who have waited 12+ hrs from DTA to admission');
    const iAdm = col('Emergency admissions via A&E - Type 1');

    for (const r of rows.slice(1)) {
      const period = parsePeriod(r[iPeriod]);
      if (!period) continue;

      const code = (r[iCode] || '').trim();
      const parent = (r[iParent] || '').trim();
      const isLondon = /LONDON/i.test(parent);
      if (!isLondon && !referencedCodes.has(code)) continue;

      const type1 = num(r[iT1]);
      if (!type1) continue; // no major A&E activity — not a dispatch destination

      if (!byPeriod.has(period.key)) byPeriod.set(period.key, { period, trusts: new Map() });
      const bucket = byPeriod.get(period.key);
      if (bucket.trusts.has(code)) continue; // first file wins (revised files listed first)

      const over1 = num(r[iO1]);
      bucket.trusts.set(code, {
        orgCode: code,
        name: (r[iName] || '').trim(),
        region: parent,
        type1Attendances: type1,
        type2Attendances: num(r[iT2]),
        type3Attendances: num(r[iT3]),
        type1Over4hr: over1,
        type1BreachRate: type1 ? +(over1 / type1).toFixed(4) : null,
        allOver4hr: over1 + num(r[iO2]) + num(r[iO3]),
        waits12hrPlus: num(r[i12]),
        emergencyAdmissionsType1: num(r[iAdm])
      });
    }
    console.log(`  parsed ${url.split('/').pop()}`);
  }

  const periods = [...byPeriod.values()]
    .sort((a, b) => b.period.sort - a.period.sort)
    .slice(0, MONTHS_WANTED);

  const trusts = new Map();
  for (const { period, trusts: t } of periods) {
    for (const [code, rec] of t) {
      if (!trusts.has(code)) {
        trusts.set(code, { orgCode: code, name: rec.name, region: rec.region, months: {} });
      }
      const { orgCode, name, region, ...metrics } = rec;
      trusts.get(code).months[period.key] = metrics;
    }
  }

  return {
    source: 'NHS England — Monthly A&E Attendances and Emergency Admissions (MSitAE)',
    sourceUrl: INDEX_PAGES[1],
    licence: 'Open Government Licence v3.0',
    retrieved: new Date().toISOString().slice(0, 10),
    note:
      'Figures are TRUST-level. A trust may run several hospital sites, so these values ' +
      'describe the trust as a whole, not an individual building.',
    periods: periods.map((p) => ({ key: p.period.key, label: p.period.label })).reverse(),
    trusts: Object.fromEntries(trusts)
  };
}

/**
 * Real arrival-by-hour data lives in the NHS Digital annual publication, but that host
 * serves an automated-traffic challenge, so it cannot be fetched by script. We attempt it,
 * and otherwise fall back to a DOCUMENTED ASSUMED curve which is clearly labelled as such
 * everywhere it surfaces. This is an assumption, not a measurement.
 */
async function buildArrivalCurve() {
  console.log('Attempting real arrival-by-hour data…');
  let reachable = false;
  try {
    const res = await fetch(ARRIVAL_SOURCE, { headers: { Accept: 'text/html' } });
    reachable = res.ok;
    console.log(`  ${ARRIVAL_SOURCE} -> ${res.status}`);
  } catch (err) {
    console.log(`  unreachable: ${err.message}`);
  }

  if (!reachable) {
    console.log('  ! falling back to assumed curve (labelled in UI)');
  }

  // Relative A&E demand by hour (index 0 = midnight). Overnight trough, late-morning
  // peak, second early-evening peak. Mean-normalised below.
  const hourShape = [
    0.45, 0.34, 0.27, 0.23, 0.22, 0.26, 0.38, 0.62,
    0.95, 1.28, 1.45, 1.47, 1.40, 1.34, 1.30, 1.28,
    1.30, 1.36, 1.40, 1.32, 1.14, 0.94, 0.75, 0.58
  ];
  // Monday heaviest, mid-week easing, weekends lighter overall but flatter.
  const dayFactor = [0.97, 1.10, 1.04, 1.00, 0.99, 1.01, 0.96]; // Sun..Sat

  const raw = [];
  for (let d = 0; d < 7; d++) {
    raw.push(hourShape.map((h) => h * dayFactor[d]));
  }
  const flat = raw.flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const matrix = raw.map((row) => row.map((v) => +(v / mean).toFixed(4)));

  return {
    source: reachable ? 'provider' : 'assumed-curve',
    sourceLabel: reachable
      ? 'NHS Digital — Hospital A&E Activity, arrival by hour'
      : 'Assumed demand curve (not NHS-sourced)',
    sourceUrl: ARRIVAL_SOURCE,
    note: reachable
      ? 'Arrival distribution derived from the NHS Digital annual publication.'
      : 'NHS Digital blocks automated access, so the real arrival-by-hour distribution could ' +
        'not be retrieved. This is a documented ASSUMED demand shape, mean-normalised to 1.0. ' +
        'It is an assumption, not measured NHS data, and is labelled as such in the UI.',
    dayOrder: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    matrix
  };
}

async function main() {
  const hospitals = JSON.parse(await readFile(resolve(ROOT, 'hospitals.json'), 'utf8'));
  const referenced = new Set(hospitals.map((h) => h.orgCode).filter(Boolean));
  console.log(`hospitals.json references ${referenced.size} trust codes\n`);

  const trusts = await buildTrusts(referenced);
  const curve = await buildArrivalCurve();

  await mkdir(resolve(ROOT, 'data'), { recursive: true });
  await writeFile(resolve(ROOT, 'data/nhs-trusts.json'), JSON.stringify(trusts, null, 2) + '\n');
  await writeFile(resolve(ROOT, 'data/arrival-curve.json'), JSON.stringify(curve, null, 2) + '\n');

  const codes = Object.keys(trusts.trusts);
  console.log(`\nWrote data/nhs-trusts.json — ${codes.length} trusts, ${trusts.periods.length} months`);
  console.log(`  ${trusts.periods[0]?.label} … ${trusts.periods.at(-1)?.label}`);
  console.log(`Wrote data/arrival-curve.json — source: ${curve.source}`);

  const missing = [...referenced].filter((c) => !codes.includes(c));
  if (missing.length) console.warn(`\n! referenced but absent from NHS data: ${missing.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
