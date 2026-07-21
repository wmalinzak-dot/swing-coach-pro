// Tests the swing analysis engine against synthetic skeletons.
//
// idealModel.js and analysis.js are pure functions over plain objects, so they
// run in Node with no device. pose.js is mocked because it pulls in native
// modules (TFLite, expo-image-manipulator) that cannot load here — analysis.js
// only needs MIN_SCORE from it.
//
// This covers geometry, phase labeling, and fault thresholds. It deliberately
// covers NONE of the pose detection, camera, or worklet layers.

jest.mock('../pose', () => ({ MIN_SCORE: 0.5 }));

import { buildIdealModel } from '../idealModel';
import { labelPhases, analyzeFrames } from '../analysis';

const RIGHT_HANDED = 'right';

// A face-on body, positioned so each fault threshold can be driven precisely.
//
// spineTiltDeg  — shoulders offset from the hip line, i.e. forward bend.
// kneeOffsetPx  — lateral knee displacement; 26px ≈ 160° knee, 0px = locked.
// leadElbowBend — 0 keeps shoulder/elbow/wrist collinear (180° lead arm);
//                 larger values fold the arm.
//
// Every landmark scores 0.9, comfortably above MIN_SCORE, so nothing is
// filtered out by the P() guard in analysis.js.
function body({
  spineTiltDeg = 32,
  leadWristY = 500,
  kneeOffsetPx = 26,
  leadElbowBend = 0,
  noseX = 400,
  trailHeelY = 760,
} = {}) {
  const hipY = 450;
  const shoY = 300;
  const dx = Math.tan((spineTiltDeg * Math.PI) / 180) * (hipY - shoY);
  const k = (x, y) => ({ x, y, z: 0, score: 0.9 });

  const leadShoX = 360 + dx;
  const trailShoX = 440 + dx;
  // Elbow on the shoulder→wrist line keeps the arm straight; bending pushes it
  // sideways off that line.
  const leadElbow = k(leadShoX + leadElbowBend, (shoY + leadWristY) / 2);

  return {
    nose: k(noseX, 200),
    left_shoulder: k(leadShoX, shoY),
    right_shoulder: k(trailShoX, shoY),
    left_elbow: leadElbow,
    right_elbow: k(trailShoX + 46, (shoY + leadWristY) / 2),
    left_wrist: k(leadShoX, leadWristY),
    right_wrist: k(trailShoX + 20, leadWristY),
    left_hip: k(370, hipY),
    right_hip: k(430, hipY),
    left_knee: k(370 + kneeOffsetPx, 600),
    right_knee: k(430 + kneeOffsetPx, 600),
    left_ankle: k(370, 750),
    right_ankle: k(430, 750),
    left_heel: k(360, 760),
    right_heel: k(420, trailHeelY),
    left_foot_index: k(390, 755),
    right_foot_index: k(450, 755),
  };
}

const frame = (timeMs, keypoints) => ({ timeMs, width: 800, height: 900, keypoints });

// Lead wrist height through a swing: address → top → down through impact → finish.
const WRIST_TRACK = [500, 420, 330, 210, 340, 500, 380, 260];

const buildSwing = (setupOverrides = {}, restOverrides = {}) =>
  WRIST_TRACK.map((y, i) =>
    frame(i * 100, body({ leadWristY: y, ...(i === 0 ? setupOverrides : restOverrides) }))
  );

const analyze = (setupOverrides, restOverrides) =>
  analyzeFrames(labelPhases(buildSwing(setupOverrides, restOverrides), RIGHT_HANDED), IDEAL);

const IDEAL = buildIdealModel({
  heightCm: 178, weightKg: 80, wingspanCm: 178,
  age: 35, flexibility: 'average', handedness: RIGHT_HANDED, club: 'driver',
});

const faultIdsAt = (frames, phase) =>
  frames.filter((f) => f.phase === phase).flatMap((f) => f.faults.map((x) => x.id));

describe('buildIdealModel — targets adapt to the body', () => {
  // Club is held constant so height is the only variable; the club adjustment
  // moves the same number and would otherwise confound the comparison.
  const driver = (over) =>
    buildIdealModel({ heightCm: 178, weightKg: 80, wingspanCm: 178, age: 35,
      flexibility: 'average', handedness: RIGHT_HANDED, club: 'driver', ...over });

  it('asks taller players for more forward bend than shorter ones', () => {
    expect(driver({ heightCm: 193 }).model.spineTiltAtAddress[0])
      .toBeGreaterThan(driver({ heightCm: 165 }).model.spineTiltAtAddress[0]);
  });

  it('lowers the hip-clearance demand for older, less flexible players', () => {
    expect(driver({ age: 62, flexibility: 'low' }).model.hipOpenAtImpact[0])
      .toBeLessThan(driver({ age: 28, flexibility: 'high' }).model.hipOpenAtImpact[0]);
  });

  it('widens head-sway tolerance at high BMI', () => {
    expect(driver({ weightKg: 110, heightCm: 170 }).model.headSwayMaxPctShoulderWidth)
      .toBeGreaterThan(driver({ weightKg: 70, heightCm: 180 }).model.headSwayMaxPctShoulderWidth);
  });

  it('tightens the lead-arm target for long arms', () => {
    expect(driver({ wingspanCm: 190 }).model.leadArmStraightTop[0])
      .toBeGreaterThan(driver({ wingspanCm: 178 }).model.leadArmStraightTop[0]);
  });

  it('stands the player taller for a driver than a wedge', () => {
    const d = buildIdealModel({ club: 'driver' }).model.spineTiltAtAddress[0];
    const w = buildIdealModel({ club: 'wedge' }).model.spineTiltAtAddress[0];
    expect(d).toBeLessThan(w);
  });
});

describe('labelPhases — locates the swing positions', () => {
  const labeled = labelPhases(buildSwing(), RIGHT_HANDED);

  it('treats the first frame as setup', () => {
    expect(labeled[0].phase).toBe('setup');
  });

  it('puts the top at the highest lead wrist', () => {
    // WRIST_TRACK index 3 (y=210) is the minimum, i.e. highest on screen.
    expect(labeled[3].phase).toBe('top');
  });

  it('finds exactly one impact frame, after the top', () => {
    const impacts = labeled.filter((f) => f.phase === 'impact');
    expect(impacts).toHaveLength(1);
    expect(labeled.indexOf(impacts[0])).toBeGreaterThan(3);
  });

  it('orders the phases setup → backswing → top → downswing → impact → finish', () => {
    expect(labeled.map((f) => f.phase)).toEqual([
      'setup', 'backswing', 'backswing', 'top',
      'downswing', 'impact', 'follow-through', 'follow-through',
    ]);
  });
});

describe('analyzeFrames — fires on real faults, stays quiet otherwise', () => {
  it('reports no posture fault for a sound address position', () => {
    const ids = faultIdsAt(analyze({ spineTiltDeg: 32, kneeOffsetPx: 26 }), 'setup');
    expect(ids).not.toContain('setup-too-upright');
    expect(ids).not.toContain('setup-too-bent');
    expect(ids).not.toContain('setup-locked-knees');
  });

  it('flags a near-vertical spine as too upright', () => {
    expect(faultIdsAt(analyze({ spineTiltDeg: 6 }), 'setup')).toContain('setup-too-upright');
  });

  it('flags excessive forward bend', () => {
    expect(faultIdsAt(analyze({ spineTiltDeg: 60 }), 'setup')).toContain('setup-too-bent');
  });

  it('flags straight, locked knees at address', () => {
    expect(faultIdsAt(analyze({ kneeOffsetPx: 0 }), 'setup')).toContain('setup-locked-knees');
  });

  it('flags the head sliding off the ball during the backswing', () => {
    // Shoulders are 80px apart and the limit is 35% of that, so 90px is well over.
    const swung = analyze({}, { noseX: 490 });
    expect([...faultIdsAt(swung, 'backswing'), ...faultIdsAt(swung, 'top')])
      .toContain('head-sway');
  });

  it('does not flag head sway when the head stays put', () => {
    const steady = analyze();
    expect([...faultIdsAt(steady, 'backswing'), ...faultIdsAt(steady, 'top')])
      .not.toContain('head-sway');
  });

  it('flags a collapsed lead arm at the top', () => {
    expect(faultIdsAt(analyze({}, { leadElbowBend: 70 }), 'top')).toContain('bent-lead-arm');
  });
});

describe('fault objects are renderable by FrameOverlay', () => {
  const allFaults = [
    ...analyze({ spineTiltDeg: 6, kneeOffsetPx: 0 }),
    ...analyze({}, { noseX: 490, leadElbowBend: 70 }),
  ].flatMap((f) => f.faults);

  it('produces faults to inspect', () => {
    expect(allFaults.length).toBeGreaterThan(0);
  });

  it('gives every fault an id, label, coaching tip and severity', () => {
    for (const f of allFaults) {
      expect(f).toEqual(expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        tip: expect.any(String),
      }));
      expect(['major', 'minor']).toContain(f.severity);
    }
  });

  it('gives every fault drawable edges and a circle target', () => {
    for (const f of allFaults) {
      expect(Array.isArray(f.edges)).toBe(true);
      expect(Array.isArray(f.circleAround)).toBe(true);
      expect(f.circleAround.length).toBeGreaterThan(0);
    }
  });
});
