// Builds the "hypothetical best" swing model for THIS body.
// All angle targets are in degrees. Ranges are [min, max] of acceptable values.
// Baseline targets come from widely-taught swing geometry, then get adjusted
// by height, weight, wingspan, age and flexibility.

export const DEFAULT_PROFILE = {
  heightCm: 178,
  weightKg: 80,
  wingspanCm: 178, // ape index ~= height if unknown
  age: 35,
  flexibility: 'average', // 'low' | 'average' | 'high'
  handedness: 'right', // 'right' | 'left'
  club: 'driver', // 'driver' | 'iron' | 'wedge'
};

function clampRange([lo, hi], shift, widen = 0) {
  return [lo + shift - widen, hi + shift + widen];
}

export function buildIdealModel(profile) {
  const p = { ...DEFAULT_PROFILE, ...profile };

  // ---- Derived body factors ----
  const bmi = p.weightKg / Math.pow(p.heightCm / 100, 2);
  const apeIndex = p.wingspanCm - p.heightCm; // + means long arms
  const tall = p.heightCm >= 188;
  const short = p.heightCm <= 168;
  const heavy = bmi >= 30;
  const senior = p.age >= 55;
  const flexShift =
    p.flexibility === 'high' ? 1 : p.flexibility === 'low' ? -1 : 0;

  // ---- Baseline geometry (mid-iron neutral model) ----
  const model = {
    // Address / setup
    spineTiltAtAddress: [30, 42], // forward bend from vertical
    kneeFlexAtAddress: [150, 168], // inside-knee angle (180 = straight)

    // Backswing → top
    leadArmStraightTop: [155, 180], // lead elbow angle at top
    trailElbowTop: [70, 110], // "tray position"
    headSwayMaxPctShoulderWidth: 35, // lateral head drift limit

    // Downswing / impact
    spineTiltAtImpact: [26, 42],
    hipOpenAtImpact: [25, 55], // hips open toward target (proxy from hip line)
    leadLegImpact: [150, 180], // posting into lead leg

    // Follow-through
    balanceFinish: true,
  };

  // ---- Club adjustments ----
  if (p.club === 'driver') {
    model.spineTiltAtAddress = clampRange(model.spineTiltAtAddress, -4); // stand taller
    model.spineTiltAtImpact = clampRange(model.spineTiltAtImpact, -4);
  } else if (p.club === 'wedge') {
    model.spineTiltAtAddress = clampRange(model.spineTiltAtAddress, +3);
  }

  // ---- Body adjustments ----
  if (tall) {
    // Taller players bend more from the hips, slightly more knee flex
    model.spineTiltAtAddress = clampRange(model.spineTiltAtAddress, +3);
    model.kneeFlexAtAddress = clampRange(model.kneeFlexAtAddress, -4);
  }
  if (short) {
    model.spineTiltAtAddress = clampRange(model.spineTiltAtAddress, -3);
    model.kneeFlexAtAddress = clampRange(model.kneeFlexAtAddress, +3);
  }
  if (heavy) {
    // Wider base, a bit more head-sway tolerance, less hip-open demand
    model.headSwayMaxPctShoulderWidth += 8;
    model.hipOpenAtImpact = clampRange(model.hipOpenAtImpact, -5, 3);
  }
  if (apeIndex >= 5) {
    // Long arms: lead arm stays straighter more easily → tighter demand
    model.leadArmStraightTop = clampRange(model.leadArmStraightTop, +3);
  } else if (apeIndex <= -5) {
    model.leadArmStraightTop = clampRange(model.leadArmStraightTop, -6, 2);
  }
  if (senior || flexShift < 0) {
    // Allow a softer lead arm and less hip clearance
    model.leadArmStraightTop = clampRange(model.leadArmStraightTop, -8, 3);
    model.hipOpenAtImpact = clampRange(model.hipOpenAtImpact, -8, 3);
  }
  if (flexShift > 0) {
    model.hipOpenAtImpact = clampRange(model.hipOpenAtImpact, +5);
  }

  return { profile: p, model, bmi: Math.round(bmi * 10) / 10 };
}

// Human-readable summary of the personalized model
export function describeModel(ideal) {
  const m = ideal.model;
  const f = (r) => `${Math.round(r[0])}–${Math.round(r[1])}°`;
  return [
    `Setup spine tilt: ${f(m.spineTiltAtAddress)}`,
    `Setup knee flex: ${f(m.kneeFlexAtAddress)} (180° = straight)`,
    `Lead arm at top: ${f(m.leadArmStraightTop)}`,
    `Hips open at impact: ${f(m.hipOpenAtImpact)}`,
    `Head sway limit: ${m.headSwayMaxPctShoulderWidth}% of shoulder width`,
  ];
}
