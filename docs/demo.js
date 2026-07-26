// A synthetic swing with known faults, for trying the app without a video.
// Ported from src/demoSwing.js — feeds the same engine as real footage.
//
// Two web-only additions on top of the native port, both for the club-tracking
// feature: real-world frame timings (so the tempo ratio means something) and an
// explicit clubhead arc (the pixel tracker has no picture to look at here).

function demoPose({ spineTiltDeg = 32, wristY = 500, kneeOffsetPx = 26, elbowBend = 0, noseX = 400, hipTwistZ = 0, trailHeelY = 760 } = {}) {
  const hipY = 450, shoY = 300;
  const dx = Math.tan((spineTiltDeg * Math.PI) / 180) * (hipY - shoY);
  const p = (x, y, z = 0) => ({ x, y, z, score: 0.92 });
  const leadShoX = 360 + dx, trailShoX = 440 + dx, elbowY = (shoY + wristY) / 2;
  return {
    nose: p(noseX, 200),
    left_shoulder: p(leadShoX, shoY), right_shoulder: p(trailShoX, shoY),
    left_elbow: p(leadShoX + elbowBend, elbowY), right_elbow: p(trailShoX + 46, elbowY),
    left_wrist: p(leadShoX, wristY), right_wrist: p(trailShoX + 20, wristY),
    left_hip: p(370, hipY, 0), right_hip: p(430, hipY, hipTwistZ),
    left_knee: p(370 + kneeOffsetPx, 600), right_knee: p(430 + kneeOffsetPx, 600),
    left_ankle: p(370, 750), right_ankle: p(430, 750),
    left_heel: p(360, 760), right_heel: p(420, trailHeelY),
    left_foot_index: p(390, 755), right_foot_index: p(450, 755),
  };
}

// Timings are the real thing: a ~0.75s backswing and a ~0.22s downswing, the
// 3:1 that tour tempo is measured against. The downswing is sampled densely
// because that is what a 30fps clip of a real swing gives you.
const SEQUENCE = [
  { t: 0, wristY: 500, spineTiltDeg: 32 },
  { t: 250, wristY: 430, spineTiltDeg: 32, noseX: 430 },
  { t: 500, wristY: 330, spineTiltDeg: 32, noseX: 458 },
  { t: 750, wristY: 215, spineTiltDeg: 32, noseX: 462, elbowBend: 72 },
  { t: 833, wristY: 290, spineTiltDeg: 30, noseX: 452, elbowBend: 55 },
  { t: 900, wristY: 400, spineTiltDeg: 26, noseX: 440, elbowBend: 30 },
  { t: 967, wristY: 505, spineTiltDeg: 9, noseX: 415, hipTwistZ: 8 },
  { t: 1067, wristY: 400, spineTiltDeg: 20, noseX: 405, trailHeelY: 760 },
  { t: 1200, wristY: 300, spineTiltDeg: 22, noseX: 400, trailHeelY: 760 },
  { t: 1400, wristY: 250, spineTiltDeg: 24, noseX: 400, trailHeelY: 760 },
];

// The clubhead runs on a circle centred at (ARC.cx, ARC.cy). Its lowest point
// is directly below the centre — at x=360, a touch past the ball at x≈374 in
// the target direction, which is what a decent strike looks like. The ball is
// reached just before that low point, so the club is still a shade descending:
// fine for an iron, and the flaw the sample is built to show for a driver.
const ARC = { cx: 360, cy: 430, r: 325 };
const ARC_ANGLES = { 4: 78, 5: 42, 6: 2.5, 7: -42, 8: -85, 9: -120 };

function clubheadAt(i) {
  const a = ARC_ANGLES[i];
  if (a == null) return null;
  const rad = (a * Math.PI) / 180;
  return {
    x: ARC.cx + ARC.r * Math.sin(rad),
    y: ARC.cy + ARC.r * Math.cos(rad),
    z: 0,
    score: 0.9,
  };
}

export function buildDemoSwing() {
  return SEQUENCE.map(({ t, ...params }, i) => {
    const keypoints = demoPose(params);
    const club = clubheadAt(i);
    if (club) keypoints.clubhead = club;
    if (i === 0) {
      // At address the club is on the ball, so both points come from the ball.
      keypoints.ball = { x: 374, y: 755, z: 0, score: 0.9, estimated: false };
      keypoints.clubhead = { x: 374, y: 755, z: 0, score: 0.6 };
    }
    return { timeMs: t, width: 800, height: 900, keypoints };
  });
}
