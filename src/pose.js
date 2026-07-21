// BlazePose Full (33 landmarks) running on-device via react-native-fast-tflite
// with GPU delegates (CoreML on iOS, GPU on Android).
//
// Pipeline per frame:
//   1. Square ROI crop (tracked from the previous frame's landmarks — this is
//      how MediaPipe's own pipeline stays fast and accurate)
//   2. Native crop + resize to 256×256 via expo-image-manipulator
//   3. Decode the tiny JPEG in JS (jpeg-js) → normalized Float32 RGB
//   4. Run the landmark model → 33 keypoints with visibility
//   5. Map coordinates back through the crop transform into full-frame pixels

import { loadTensorflowModel } from 'react-native-fast-tflite';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import jpeg from 'jpeg-js';

const INPUT = 256;

// BlazePose landmark index → name (MoveNet-compatible names + feet/hands extras)
export const LANDMARK_NAMES = {
  0: 'nose',
  11: 'left_shoulder',
  12: 'right_shoulder',
  13: 'left_elbow',
  14: 'right_elbow',
  15: 'left_wrist',
  16: 'right_wrist',
  23: 'left_hip',
  24: 'right_hip',
  25: 'left_knee',
  26: 'right_knee',
  27: 'left_ankle',
  28: 'right_ankle',
  29: 'left_heel',
  30: 'right_heel',
  31: 'left_foot_index',
  32: 'right_foot_index',
};

export const EDGES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['left_ankle', 'left_heel'],
  ['left_heel', 'left_foot_index'],
  ['right_ankle', 'right_heel'],
  ['right_heel', 'right_foot_index'],
];

export const MIN_SCORE = 0.5;

let model = null;
let lastRoi = null; // tracked between frames of the same video

export function resetTracking() {
  lastRoi = null;
}

export async function initPose() {
  if (model) return model;
  const source = require('../assets/pose_landmark_full.tflite');
  const delegates =
    Platform.OS === 'ios' ? ['core-ml', 'metal', 'default'] : ['android-gpu', 'default'];
  let lastErr;
  for (const d of delegates) {
    try {
      model = await loadTensorflowModel(source, d);
      return model;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function squareRoi(frameW, frameH, roi) {
  // Expand to square, clamp inside the frame
  let { cx, cy, size } = roi;
  size = Math.min(size, frameW, frameH);
  let x = Math.round(Math.min(Math.max(cx - size / 2, 0), frameW - size));
  let y = Math.round(Math.min(Math.max(cy - size / 2, 0), frameH - size));
  return { x, y, size: Math.round(size) };
}

function roiFromLandmarks(kp, frameW, frameH) {
  const pts = Object.values(kp).filter((p) => p.score >= MIN_SCORE);
  if (pts.length < 8) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // 1.5× padding around the body — arms swing well outside the torso box
  const size = Math.max(maxX - minX, maxY - minY) * 1.5;
  return squareRoi(frameW, frameH, { cx, cy, size });
}

async function cropTo256(uri, roi) {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [
      { crop: { originX: roi.x, originY: roi.y, width: roi.size, height: roi.size } },
      { resize: { width: INPUT, height: INPUT } },
    ],
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG }
  );
  return result.uri;
}

async function jpegToFloat32(uri) {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const { data, width, height } = jpeg.decode(Buffer.from(b64, 'base64'), {
    useTArray: true,
  });
  // RGBA → normalized RGB float32
  const out = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    out[j++] = data[i] / 255;
    out[j++] = data[i + 1] / 255;
    out[j++] = data[i + 2] / 255;
  }
  return out;
}

// frame: { uri, width, height, timeMs }
// returns { keypoints: {name: {x, y, z, score}}, poseScore }
export async function detectFrame(frame) {
  const m = await initPose();

  // ROI: previous frame's tracked box, else full-frame center square
  const roi =
    lastRoi ||
    squareRoi(frame.width, frame.height, {
      cx: frame.width / 2,
      cy: frame.height / 2,
      size: Math.min(frame.width, frame.height),
    });

  const croppedUri = await cropTo256(frame.uri, roi);
  const input = await jpegToFloat32(croppedUri);
  FileSystem.deleteAsync(croppedUri, { idempotent: true }).catch(() => {});

  const outputs = m.runSync([input]);

  // Find tensors by size: landmarks = 195 floats (39 × 5), poseflag = 1 float
  let ld = null;
  let flag = 1;
  for (const t of outputs) {
    if (t.length === 195) ld = t;
    else if (t.length === 1) flag = sigmoid(t[0]);
  }
  if (!ld) throw new Error('Unexpected model output — wrong .tflite file?');

  const scaleBack = roi.size / INPUT;
  const kp = {};
  for (const [idxStr, name] of Object.entries(LANDMARK_NAMES)) {
    const i = Number(idxStr) * 5;
    const visibility = sigmoid(ld[i + 3]);
    const presence = sigmoid(ld[i + 4]);
    kp[name] = {
      x: roi.x + ld[i] * scaleBack,
      y: roi.y + ld[i + 1] * scaleBack,
      z: ld[i + 2] * scaleBack, // relative depth (hip-centered), same scale
      score: Math.min(visibility, presence) * flag,
    };
  }

  // Track ROI for the next frame; drop tracking if the pose was lost
  lastRoi = flag > 0.5 ? roiFromLandmarks(kp, frame.width, frame.height) : null;

  return { keypoints: kp, poseScore: flag };
}
