/**
 * Best-destination ranking engine.
 *
 * clinical capability × patient condition × travel time × operational capacity
 *
 * Clinical capability is a HARD GATE, not a weighted term: a hospital without the required
 * designation is not a candidate at any distance. Only once that gate is passed do travel
 * time and hospital load compete.
 */

import { WEIGHTS, buildProfile } from './clinical.js';

export { buildProfile };

/** Preferred-but-not-required tags each contribute this much clinical credit. */
const PREFERRED_CREDIT = 0.25;

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Capability tags for a hospital. `services` in hospitals.json is the single source of
 * truth, shared with the driver dispatch view. TYPE1_ED is derived from aeType rather than
 * tagged, so the two representations cannot drift apart.
 */
function tagsFor(hospital) {
  const tags = hospital.services ? [...hospital.services] : [];
  if (hospital.aeType === 1) tags.push('TYPE1_ED');
  return tags;
}

/** Which of these tags are designation types we could not confirm from a primary source. */
function unverifiedTags(caps, tags) {
  const v = caps?.verifiedTags ?? {};
  return tags.filter((t) => v[t] === false);
}

/**
 * Select candidate hospitals for a profile.
 * Returns { candidates, fallback, excluded } — `fallback` is true when nothing met the
 * clinical requirement and we widened to any major A&E rather than returning nothing.
 */
export function selectCandidates(hospitals, caps, profile) {
  const required = profile.requiredTags;

  const qualifies = (h) => {
    const tags = tagsFor(h);
    return required.every((t) => tags.includes(t));
  };

  let candidates = hospitals.filter(qualifies);
  let fallback = false;

  if (!candidates.length) {
    // Never silently drop a clinical requirement — widen, but say so loudly.
    candidates = hospitals.filter((h) => tagsFor(h).includes('TYPE1_ED'));
    fallback = true;
  }

  const excluded = hospitals.filter((h) => !candidates.includes(h) && h.aeType === 1);
  return { candidates, fallback, excluded };
}

/** Clinical suitability 0..1 — required tags are already guaranteed by the gate. */
function clinicalScore(caps, h, profile) {
  const tags = tagsFor(h);
  let score = 1;
  const extra = profile.preferredTags.filter((t) => tags.includes(t)).length;
  score += extra * PREFERRED_CREDIT;
  return Math.min(1, score / (1 + profile.preferredTags.length * PREFERRED_CREDIT));
}

/**
 * Rank candidates. `travelMin[i]` corresponds to `candidates[i]`; entries may be null when
 * a drive time could not be resolved, in which case that hospital drops to the bottom.
 */
export function rank({ candidates, travelMin, capacityStates, profile, caps }) {
  const w = WEIGHTS[profile.urgency];
  const valid = travelMin.filter((t) => typeof t === 'number' && isFinite(t));
  const maxTravel = valid.length ? Math.max(...valid) : 1;
  const minTravel = valid.length ? Math.min(...valid) : 0;
  const span = Math.max(1e-6, maxTravel - minTravel);

  const scored = candidates.map((h, i) => {
    const travel = travelMin[i];
    const cap = capacityStates[i];
    const tags = tagsFor(h);

    // Normalised so the best candidate scores 1 and the worst 0 on each axis.
    const travelScore = travel == null ? 0 : 1 - (travel - minTravel) / span;
    const capacityScore = 1 - cap.penalty;
    const clinical = clinicalScore(caps, h, profile);

    const score =
      w.travel * travelScore + w.capacity * capacityScore + w.clinical * clinical;

    const reasons = [];
    const met = profile.requiredTags.filter((t) => tags.includes(t));
    if (met.length) reasons.push(`Meets ${met.join(' + ')} requirement`);
    if (cap.status === 'divert') reasons.push('Declared on divert — heavily penalised');
    else if (cap.status === 'pressure') reasons.push('Declared under pressure');
    if (h.aeType === null) reasons.push('Direct admission — no A&E at this site');

    return {
      hospital: h,
      travelMin: travel,
      capacity: cap,
      tags,
      unverified: unverifiedTags(caps, met),
      score,
      breakdown: { travelScore, capacityScore, clinical, weights: w },
      reasons
    };
  });

  return scored.sort((a, b) => {
    if (a.travelMin == null && b.travelMin != null) return 1;
    if (b.travelMin == null && a.travelMin != null) return -1;
    return b.score - a.score;
  });
}

/**
 * Explain why the top pick beat the closest candidate that ranked below it.
 * Returns null when the top pick is also the closest.
 */
export function compareToNearest(ranked) {
  const routable = ranked.filter((r) => r.travelMin != null);
  if (routable.length < 2) return null;

  const top = routable[0];
  const nearest = routable.reduce((a, b) => (b.travelMin < a.travelMin ? b : a));
  if (nearest === top) return null;

  const extraMin = Math.round(top.travelMin - nearest.travelMin);
  // Phrased to follow the hospital name in the sentence, so it must not repeat it.
  const cause =
    nearest.capacity.status === 'divert'
      ? 'is on divert'
      : nearest.capacity.status === 'pressure'
        ? 'is under declared pressure'
        : 'is carrying more load';

  return { nearest, top, extraMin, cause };
}
