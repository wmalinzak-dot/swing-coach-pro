// A synthetic right-handed swing with known, deliberate faults.
//
// Real pose detection needs a device, but the analysis engine only ever sees
// keypoints — so feeding it hand-built skeletons exercises the genuine
// labelPhases → analyzeFrames path. Used by the web preview, and useful on
// device for checking the results UI without filming anything.
//
// Frames carry no `uri`, so FrameOverlay falls back to skeleton-on-turf.

// Landmarks are laid out in a 800×900 frame, face-on.
//
// spineTiltDeg  forward bend from vertical (drives the shoulder offset)
// kneeOffsetPx  lateral knee displacement; ~26px ≈ 160° knee, 0 = locked
// elbowBend     0 keeps the lead arm straight; larger folds it
// hipTwistZ     depth difference between the hips = hip rotation toward target
function pose({
  spineTiltDeg = 32,
  wristY = 500,
  kneeOffsetPx = 26,
  elbowBend = 0,
  noseX = 400,
  hipTwistZ = 0,
  trailHeelY = 760,
} = {}) {
  const hipY = 450;
  const shoY = 300;
  const dx = Math.tan((spineTiltDeg * Math.PI) / 180) * (hipY - shoY);
  const p = (x, y, z = 0) => ({ x, y, z, score: 0.92 });

  const leadShoX = 360 + dx;
  const trailShoX = 440 + dx;
  const elbowY = (shoY + wristY) / 2;

  return {
    nose: p(noseX, 200),
    left_shoulder: p(leadShoX, shoY),
    right_shoulder: p(trailShoX, shoY),
    left_elbow: p(leadShoX + elbowBend, elbowY),
    right_elbow: p(trailShoX + 46, elbowY),
    left_wrist: p(leadShoX, wristY),
    right_wrist: p(trailShoX + 20, wristY),
    left_hip: p(370, hipY, 0),
    right_hip: p(430, hipY, hipTwistZ),
    left_knee: p(370 + kneeOffsetPx, 600),
    right_knee: p(430 + kneeOffsetPx, 600),
    left_ankle: p(370, 750),
    right_ankle: p(430, 750),
    left_heel: p(360, 760),
    right_heel: p(420, trailHeelY),
    left_foot_index: p(390, 755),
    right_foot_index: p(450, 755),
  };
}

// The swing being modelled: a decent address position that slides off the ball
// going back, collapses the lead arm at the top, then stands up through impact
// with the hips barely rotating — a common amateur pattern.
const SEQUENCE = [
  { wristY: 500, spineTiltDeg: 32 },                                  // setup, sound
  { wristY: 430, spineTiltDeg: 32, noseX: 430 },                      // takeaway, head drifting
  { wristY: 330, spineTiltDeg: 32, noseX: 458 },                      // backswing, sway growing
  { wristY: 215, spineTiltDeg: 32, noseX: 462, elbowBend: 72 },       // top, lead arm folded
  { wristY: 355, spineTiltDeg: 26, noseX: 440, elbowBend: 30 },       // downswing
  { wristY: 505, spineTiltDeg: 9, noseX: 415, hipTwistZ: 8 },         // impact, standing up
  { wristY: 380, spineTiltDeg: 20, noseX: 405, trailHeelY: 760 },     // release, foot still flat
  { wristY: 250, spineTiltDeg: 24, noseX: 400, trailHeelY: 760 },     // finish
];

export function buildDemoSwing() {
  return SEQUENCE.map((params, i) => ({
    timeMs: i * 110,
    width: 800,
    height: 900,
    keypoints: pose(params),
  }));
}
