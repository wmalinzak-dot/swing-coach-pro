// A synthetic swing with known faults, for trying the app without a video.
// Ported from src/demoSwing.js — feeds the same engine as real footage.

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
const SEQUENCE = [
  { wristY: 500, spineTiltDeg: 32 },
  { wristY: 430, spineTiltDeg: 32, noseX: 430 },
  { wristY: 330, spineTiltDeg: 32, noseX: 458 },
  { wristY: 215, spineTiltDeg: 32, noseX: 462, elbowBend: 72 },
  { wristY: 355, spineTiltDeg: 26, noseX: 440, elbowBend: 30 },
  { wristY: 505, spineTiltDeg: 9, noseX: 415, hipTwistZ: 8 },
  { wristY: 380, spineTiltDeg: 20, noseX: 405, trailHeelY: 760 },
  { wristY: 250, spineTiltDeg: 24, noseX: 400, trailHeelY: 760 },
];
export function buildDemoSwing() {
  return SEQUENCE.map((params, i) => ({
    timeMs: i * 110, width: 800, height: 900, keypoints: demoPose(params),
  }));
}
