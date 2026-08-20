/**
 * Clinical requirement profile.
 *
 * Turns structured dispatcher input into the capability a receiving hospital must hold,
 * plus how heavily travel time should weigh against hospital load.
 *
 * The pathways encoded here are real NHS London practice, not our invention: major trauma,
 * stroke and STEMI patients are already routed past nearer hospitals to designated centres.
 * What this adds is weighing operational load once the clinical requirement is satisfied.
 *
 * IMPORTANT: this is a demonstration of routing logic, not a triage tool, and it does not
 * make clinical decisions. A dispatcher accepts or overrides every recommendation.
 */

/** Scoring weights by urgency. Kept in one place so they can be argued with and tuned. */
export const WEIGHTS = {
  critical: { travel: 0.70, capacity: 0.10, clinical: 0.20 },
  high:     { travel: 0.55, capacity: 0.20, clinical: 0.25 },
  standard: { travel: 0.35, capacity: 0.45, clinical: 0.20 },
  minor:    { travel: 0.25, capacity: 0.60, clinical: 0.15 }
};

export const BLANK_CONDITION = {
  suspectedStroke: false,
  suspectedCardiac: false,
  majorTrauma: false,
  majorBleeding: false,
  unconscious: false,
  breathing: 'normal', // normal | difficulty | absent
  ageGroup: 'adult',   // adult | child
  severity: 'moderate' // minor | moderate | severe
};

/**
 * @returns {{
 *   requiredTags: string[], preferredTags: string[], urgency: keyof typeof WEIGHTS,
 *   pathway: string, rationale: string[], airway: boolean
 * }}
 */
export function buildProfile(c) {
  const rationale = [];
  const requiredTags = [];
  const preferredTags = [];

  const airway = c.unconscious || c.breathing === 'absent' || c.breathing === 'difficulty';

  // Pathway precedence. A patient can trip several flags; the most specialised
  // time-critical pathway wins, which mirrors how these are actually dispatched.
  let pathway = 'Standard emergency department';

  if (c.majorTrauma || (c.majorBleeding && c.severity === 'severe')) {
    requiredTags.push('MTC');
    pathway = 'Major trauma';
    rationale.push('Major trauma goes to a Major Trauma Centre, bypassing nearer hospitals.');
    if (c.ageGroup === 'child') {
      // Paediatric major trauma designation is NOT in the dataset, so it cannot be a hard
      // gate — requiring a tag no hospital carries would reject every candidate. Flagged
      // for the dispatcher instead. Add a PAEDS_MAJOR tag to hospitals.json to enforce it.
      rationale.push(
        'Paediatric patient — confirm the receiving centre takes paediatric major trauma. ' +
        'Not enforced automatically: that designation is not yet in the dataset.'
      );
    }
  } else if (c.suspectedStroke) {
    requiredTags.push('HASU');
    pathway = 'Suspected stroke';
    rationale.push('Suspected stroke goes to a Hyper-Acute Stroke Unit for 24/7 thrombolysis.');
  } else if (c.suspectedCardiac) {
    requiredTags.push('HAC');
    pathway = 'Suspected heart attack';
    rationale.push('Suspected heart attack goes directly to a Heart Attack Centre for primary PCI.');
    rationale.push('Some heart attack centres have no A&E — direct admission bypasses it.');
  } else {
    requiredTags.push('TYPE1_ED');
    pathway = c.severity === 'minor' ? 'Minor injury or illness' : 'Standard emergency department';
    rationale.push('No specialist pathway triggered — any major A&E can receive this patient.');
  }

  // Airway compromise: whatever the pathway, the patient needs resuscitation facilities
  // and time matters more than queue length.
  if (airway && !requiredTags.includes('MTC')) {
    if (!requiredTags.includes('TYPE1_ED') && !requiredTags.includes('HAC')) {
      preferredTags.push('TYPE1_ED');
    }
    rationale.push('Airway or breathing compromised — shortest time to a resus bay dominates.');
  }

  let urgency;
  if (c.breathing === 'absent' || c.unconscious) urgency = 'critical';
  else if (requiredTags.some((t) => t !== 'TYPE1_ED')) urgency = 'high';
  else if (c.severity === 'minor') urgency = 'minor';
  else urgency = 'standard';

  if (urgency === 'minor') {
    rationale.push('Not time-critical — hospital load weighs more heavily than distance.');
  }

  return { requiredTags, preferredTags, urgency, pathway, rationale, airway };
}
