// Compares detected poses against the personalized ideal model.
// v2: dense-frame phase detection (velocity-based impact) and new faults
// unlocked by BlazePose's 33 landmarks (heels + toes → balance, knee sway).

import { MIN_SCORE } from './constants';

const P = (kp, name) => (kp[name] && kp[name].score >= MIN_SCORE ? kp[name] : null);

function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m1 = Math.hypot(v1.x, v1.y);
  const m2 = Math.hypot(v2.x, v2.y);
  if (!m1 || !m2) return null;
  const cos = Math.min(1, Math.max(-1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function mid(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function spineTiltFromVertical(kp) {
  const hip = mid(P(kp, 'left_hip'), P(kp, 'right_hip'));
  const sho = mid(P(kp, 'left_shoulder'), P(kp, 'right_shoulder'));
  if (!hip || !sho) return null;
  const dx = sho.x - hip.x;
  const dy = sho.y - hip.y;
  return Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
}

function hipLineAngle(kp) {
  const l = P(kp, 'left_hip');
  const r = P(kp, 'right_hip');
  if (!l || !r) return null;
  return Math.abs((Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI);
}

// Hip rotation proxy using BlazePose z-depth: as hips open in face-on video,
// one hip moves toward the camera (negative z) and the other away.
function hipOpenDegrees(kp) {
  const l = kp['left_hip'];
  const r = kp['right_hip'];
  if (!l || !r || l.score < MIN_SCORE || r.score < MIN_SCORE) return null;
  const dx = Math.abs(l.x - r.x);
  const dz = r.z - l.z;
  if (dx < 1) return null;
  return Math.abs((Math.atan2(dz, dx) * 180) / Math.PI);
}

function shoulderWidth(kp) {
  const l = P(kp, 'left_shoulder');
  const r = P(kp, 'right_shoulder');
  if (!l || !r) return null;
  return Math.hypot(l.x - r.x, l.y - r.y);
}

// ---- Swing phase estimation (dense frames) ----
// top = highest lead wrist. impact = after top, the frame where the lead
// wrist has returned to its address height with the highest downward speed.
export function labelPhases(frames, handedness) {
  const lead = handedness === 'right' ? 'left' : 'right';
  const wristName = `${lead}_wrist`;

  const ys = frames.map((f) => {
    const w = P(f.keypoints, wristName);
    return w ? w.y : null;
  });

  let topIdx = 0;
  let minY = Infinity;
  ys.forEach((y, i) => {
    if (y != null && y < minY) {
      minY = y;
      topIdx = i;
    }
  });

  const addressY = ys.find((y) => y != null) ?? 0;

  // Impact: after top, minimize |y - addressY| with a bonus for downward speed
  let impactIdx = Math.min(topIdx + 1, frames.length - 1);
  let best = Infinity;
  for (let i = topIdx + 1; i < frames.length; i++) {
    if (ys[i] == null) continue;
    const dt = frames[i].timeMs - frames[i - 1].timeMs || 1;
    const vel = ys[i - 1] != null ? (ys[i] - ys[i - 1]) / dt : 0; // + = moving down
    const score = Math.abs(ys[i] - addressY) - vel * 40;
    if (score < best) {
      best = score;
      impactIdx = i;
    }
  }

  return frames.map((f, i) => {
    let phase;
    if (i === 0) phase = 'setup';
    else if (i < topIdx) phase = 'backswing';
    else if (i === topIdx) phase = 'top';
    else if (i < impactIdx) phase = 'downswing';
    else if (i === impactIdx) phase = 'impact';
    else phase = 'follow-through';
    return { ...f, phase };
  });
}

export function findTopMs(frames, handedness) {
  const lead = handedness === 'right' ? 'left' : 'right';
  let topMs = frames[Math.floor(frames.length / 2)]?.timeMs ?? 0;
  let minY = Infinity;
  for (const f of frames) {
    const w = P(f.keypoints, `${lead}_wrist`);
    if (w && w.y < minY) {
      minY = w.y;
      topMs = f.timeMs;
    }
  }
  return topMs;
}

// ---- Fault detection ----
export function analyzeFrames(labeledFrames, ideal) {
  const { model, profile } = ideal;
  const lead = profile.handedness === 'right' ? 'left' : 'right';
  const trail = profile.handedness === 'right' ? 'right' : 'left';

  const setupFrame = labeledFrames.find((f) => f.phase === 'setup');
  const baseHeadX = setupFrame ? P(setupFrame.keypoints, 'nose')?.x : null;
  const baseShoulderW = setupFrame ? shoulderWidth(setupFrame.keypoints) : null;
  const baseTrailKneeX = setupFrame ? P(setupFrame.keypoints, `${trail}_knee`)?.x : null;

  return labeledFrames.map((f) => {
    const kp = f.keypoints;
    const faults = [];

    // -------- SETUP --------
    if (f.phase === 'setup') {
      const tilt = spineTiltFromVertical(kp);
      if (tilt != null) {
        const [lo, hi] = model.spineTiltAtAddress;
        if (tilt < lo)
          faults.push({
            id: 'setup-too-upright',
            label: `Spine too upright (${Math.round(tilt)}°, ideal ${Math.round(lo)}–${Math.round(hi)}°)`,
            tip: 'Bow forward from the hips — push your belt buckle back and let your arms hang straight down under your shoulders.',
            edges: [['hips_mid', 'shoulders_mid']],
            circleAround: ['left_hip', 'right_hip', 'left_shoulder', 'right_shoulder'],
            severity: 'major',
          });
        if (tilt > hi)
          faults.push({
            id: 'setup-too-bent',
            label: `Too much forward bend (${Math.round(tilt)}°, ideal ${Math.round(lo)}–${Math.round(hi)}°)`,
            tip: 'Stand slightly taller. Too much bend locks your hips and forces an over-the-top move.',
            edges: [['hips_mid', 'shoulders_mid']],
            circleAround: ['left_hip', 'right_hip', 'left_shoulder', 'right_shoulder'],
            severity: 'major',
          });
      }
      const kneeL = angleAt(P(kp, `${lead}_hip`), P(kp, `${lead}_knee`), P(kp, `${lead}_ankle`));
      if (kneeL != null) {
        const [lo, hi] = model.kneeFlexAtAddress;
        if (kneeL > hi)
          faults.push({
            id: 'setup-locked-knees',
            label: `Knees locked (${Math.round(kneeL)}°, ideal ${Math.round(lo)}–${Math.round(hi)}°)`,
            tip: 'Soften your knees like you are about to sit onto a tall stool — athletic, not squatting.',
            edges: [[`${lead}_hip`, `${lead}_knee`], [`${lead}_knee`, `${lead}_ankle`]],
            circleAround: [`${lead}_knee`],
            severity: 'minor',
          });
        if (kneeL < lo)
          faults.push({
            id: 'setup-too-squatty',
            label: `Too much knee bend (${Math.round(kneeL)}°)`,
            tip: 'Rise up a touch. Excess knee flex kills rotation and makes you stand up through impact.',
            edges: [[`${lead}_hip`, `${lead}_knee`], [`${lead}_knee`, `${lead}_ankle`]],
            circleAround: [`${lead}_knee`],
            severity: 'minor',
          });
      }
    }

    // -------- BACKSWING / TOP --------
    if (f.phase === 'backswing' || f.phase === 'top') {
      const nose = P(kp, 'nose');
      if (nose && baseHeadX != null && baseShoulderW) {
        const swayPct = (Math.abs(nose.x - baseHeadX) / baseShoulderW) * 100;
        if (swayPct > model.headSwayMaxPctShoulderWidth)
          faults.push({
            id: 'head-sway',
            label: `Head sways off the ball (${Math.round(swayPct)}% of shoulder width)`,
            tip: 'Turn around your trail hip instead of sliding. Feel your trail hip screw into the ground as you rotate.',
            edges: [],
            circleAround: ['nose'],
            severity: 'major',
          });
      }

      // Trail-knee sway: knee drifting laterally past its address position
      const tKnee = P(kp, `${trail}_knee`);
      if (tKnee && baseTrailKneeX != null && baseShoulderW) {
        const outward =
          trail === 'right' ? tKnee.x - baseTrailKneeX : baseTrailKneeX - tKnee.x;
        if (outward > baseShoulderW * 0.35) {
          faults.push({
            id: 'knee-sway',
            label: 'Trail knee swaying away from the target',
            tip: 'Keep your trail knee flexed and braced — coil against it like a loaded spring instead of sliding over it.',
            edges: [[`${trail}_hip`, `${trail}_knee`], [`${trail}_knee`, `${trail}_ankle`]],
            circleAround: [`${trail}_knee`],
            severity: 'major',
          });
        }
      }

      if (f.phase === 'top') {
        const leadArm = angleAt(
          P(kp, `${lead}_shoulder`),
          P(kp, `${lead}_elbow`),
          P(kp, `${lead}_wrist`)
        );
        if (leadArm != null) {
          const [lo] = model.leadArmStraightTop;
          if (leadArm < lo)
            faults.push({
              id: 'bent-lead-arm',
              label: `Lead arm collapsing at the top (${Math.round(leadArm)}°, ideal ≥ ${Math.round(lo)}°)`,
              tip: 'Feel width: push your lead knuckles as far from your chest as you can at the top. A shorter, wider swing beats a long, bent one.',
              edges: [[`${lead}_shoulder`, `${lead}_elbow`], [`${lead}_elbow`, `${lead}_wrist`]],
              circleAround: [`${lead}_elbow`],
              severity: 'major',
            });
        }
        const trailElbow = angleAt(
          P(kp, `${trail}_shoulder`),
          P(kp, `${trail}_elbow`),
          P(kp, `${trail}_wrist`)
        );
        if (trailElbow != null) {
          const [lo, hi] = model.trailElbowTop;
          if (trailElbow < lo - 15 || trailElbow > hi + 25)
            faults.push({
              id: 'flying-elbow',
              label: `Trail elbow out of position (${Math.round(trailElbow)}°)`,
              tip: 'At the top, your trail elbow should point at the ground like a waiter holding a tray — not flying behind you.',
              edges: [[`${trail}_shoulder`, `${trail}_elbow`], [`${trail}_elbow`, `${trail}_wrist`]],
              circleAround: [`${trail}_elbow`],
              severity: 'minor',
            });
        }
      }
    }

    // -------- IMPACT --------
    if (f.phase === 'impact') {
      const tilt = spineTiltFromVertical(kp);
      if (tilt != null) {
        const [lo, hi] = model.spineTiltAtImpact;
        if (tilt < lo - 4)
          faults.push({
            id: 'early-extension',
            label: `Standing up through impact (spine ${Math.round(tilt)}°, ideal ${Math.round(lo)}–${Math.round(hi)}°)`,
            tip: 'Classic early extension. Keep your chest down and your rear against an imaginary wall behind you as you rotate through.',
            edges: [['hips_mid', 'shoulders_mid']],
            circleAround: ['left_hip', 'right_hip'],
            severity: 'major',
          });
      }
      // Hip rotation: prefer the z-depth measurement, fall back to hip-line tilt
      const openDeg = hipOpenDegrees(kp);
      const hipAng = hipLineAngle(kp);
      const [openLo] = model.hipOpenAtImpact;
      const stalled =
        openDeg != null
          ? openDeg < openLo * 0.5
          : hipAng != null && hipAng < Math.max(4, openLo / 4);
      if (stalled) {
        faults.push({
          id: 'stalled-hips',
          label:
            openDeg != null
              ? `Hips only ${Math.round(openDeg)}° open at impact (ideal ≥ ${Math.round(openLo)}°)`
              : 'Hips not clearing at impact',
          tip: 'Start the downswing from the ground up: bump lead hip toward the target, then rotate hard. Your belt buckle should beat your chest to the ball.',
          edges: [['left_hip', 'right_hip']],
          circleAround: ['left_hip', 'right_hip'],
          severity: 'major',
        });
      }
      const leadLeg = angleAt(
        P(kp, `${lead}_hip`),
        P(kp, `${lead}_knee`),
        P(kp, `${lead}_ankle`)
      );
      if (leadLeg != null && leadLeg < model.leadLegImpact[0]) {
        faults.push({
          id: 'no-post',
          label: `Not posting into lead leg (${Math.round(leadLeg)}°)`,
          tip: 'Straighten (post up) your lead leg through impact — that is where effortless speed comes from.',
          edges: [[`${lead}_hip`, `${lead}_knee`], [`${lead}_knee`, `${lead}_ankle`]],
          circleAround: [`${lead}_knee`],
          severity: 'minor',
        });
      }
    }

    // -------- FOLLOW-THROUGH --------
    if (f.phase === 'follow-through') {
      const hip = mid(P(kp, 'left_hip'), P(kp, 'right_hip'));
      const ankleMid = mid(P(kp, 'left_ankle'), P(kp, 'right_ankle'));
      const sw = shoulderWidth(kp);
      if (hip && ankleMid && sw && Math.abs(hip.x - ankleMid.x) > sw * 0.9) {
        faults.push({
          id: 'off-balance',
          label: 'Falling off balance in the finish',
          tip: 'Swing at 80% until you can hold your finish for 3 full seconds, weight fully on your lead foot.',
          edges: [['left_hip', 'right_hip'], ['left_hip', 'left_ankle'], ['right_hip', 'right_ankle']],
          circleAround: ['left_hip', 'right_hip'],
          severity: 'minor',
        });
      }
      // Trail heel should be UP in a full finish (weight fully transferred) —
      // heels/toes are 33-landmark exclusives.
      const tHeel = P(kp, `${trail}_heel`);
      const tToe = P(kp, `${trail}_foot_index`);
      if (tHeel && tToe && sw) {
        const heelLift = tHeel.y < tToe.y - sw * 0.05; // heel clearly above toe
        if (!heelLift) {
          faults.push({
            id: 'flat-trail-foot',
            label: 'Trail foot stays flat in the finish',
            tip: 'Finish with your trail heel fully up, toe down, laces facing the target — proof your weight actually transferred.',
            edges: [[`${trail}_ankle`, `${trail}_heel`], [`${trail}_heel`, `${trail}_foot_index`]],
            circleAround: [`${trail}_heel`, `${trail}_foot_index`],
            severity: 'minor',
          });
        }
      }
    }

    return { ...f, faults };
  });
}

export function resolvePoint(kp, name) {
  if (name === 'hips_mid') {
    const l = kp['left_hip'];
    const r = kp['right_hip'];
    if (!l || !r) return null;
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, score: Math.min(l.score, r.score) };
  }
  if (name === 'shoulders_mid') {
    const l = kp['left_shoulder'];
    const r = kp['right_shoulder'];
    if (!l || !r) return null;
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, score: Math.min(l.score, r.score) };
  }
  return kp[name] || null;
}
