// Worklet-side pose decoding.
//
// Everything in this file runs on VisionCamera's frame-processor thread, not
// the JS thread. Each exported function carries the 'worklet' directive so the
// worklets runtime can compile it; they must stay pure (no React state, no
// async, no imports resolved at call time).
//
// This replaces the disk → base64 → jpeg-js path in pose.js entirely. The
// resize plugin hands us pixels natively; we never touch a JPEG.

import { LANDMARK_NAMES, MIN_SCORE } from './pose';

export const INPUT = 256;

export function sigmoid(x) {
  'worklet';
  return 1 / (1 + Math.exp(-x));
}

// Expand an ROI to a square that stays inside the frame.
export function squareRoi(frameW, frameH, cx, cy, size) {
  'worklet';
  const s = Math.round(Math.min(size, frameW, frameH));
  const x = Math.round(Math.min(Math.max(cx - s / 2, 0), frameW - s));
  const y = Math.round(Math.min(Math.max(cy - s / 2, 0), frameH - s));
  return { x, y, size: s };
}

// Same 1.5× padded body box as the still-image pipeline — arms swing well
// outside the torso, so a tight box clips the club-side wrist at the top.
export function roiFromLandmarks(kp, frameW, frameH) {
  'worklet';
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const name in kp) {
    const p = kp[name];
    if (p.score < MIN_SCORE) continue;
    n++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (n < 8) return null;
  return squareRoi(
    frameW,
    frameH,
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    Math.max(maxX - minX, maxY - minY) * 1.5
  );
}

// Model output → keypoints in full-frame pixel coordinates.
// ld is 195 floats (39 landmarks × [x, y, z, visibility, presence]).
export function decodeLandmarks(ld, roi, flag) {
  'worklet';
  const scaleBack = roi.size / INPUT;
  const kp = {};
  for (const idxStr in LANDMARK_NAMES) {
    const i = Number(idxStr) * 5;
    const visibility = sigmoid(ld[i + 3]);
    const presence = sigmoid(ld[i + 4]);
    kp[LANDMARK_NAMES[idxStr]] = {
      x: roi.x + ld[i] * scaleBack,
      y: roi.y + ld[i + 1] * scaleBack,
      z: ld[i + 2] * scaleBack,
      score: Math.min(visibility, presence) * flag,
    };
  }
  return kp;
}

// Pick the landmark tensor (195 floats) and the pose-presence flag (1 float)
// out of the model's output list without depending on tensor ordering.
export function readOutputs(outputs) {
  'worklet';
  let ld = null;
  let flag = 1;
  for (let i = 0; i < outputs.length; i++) {
    const t = outputs[i];
    if (t.length === 195) ld = t;
    else if (t.length === 1) flag = sigmoid(t[0]);
  }
  return { ld, flag };
}
