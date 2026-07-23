// Browser pose detection via MediaPipe Tasks Vision.
//
// This is the web equivalent of the native src/pose.js. MediaPipe runs the
// same BlazePose family (33 landmarks, GPU via WebGL) that the app runs on
// device, so its output maps straight onto the keypoint shape engine.js
// expects: { name: { x, y, z, score } } in pixel units.
//
// Loaded from the jsDelivr CDN. That's fine on a normal web host like GitHub
// Pages; it would NOT work inside a claude.ai Artifact, whose sandbox blocks
// external hosts — which is exactly why this app is deployed rather than
// published as an Artifact.

import { PoseLandmarker, FilesetResolver } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs';
import { LANDMARK_NAMES } from './engine.js';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarker = null;

export async function initPose(onStatus) {
  if (landmarker) return landmarker;
  onStatus && onStatus('Loading the pose engine (first run downloads ~10 MB)…');
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  } catch (e) {
    // Some machines/browsers have no usable WebGL for the GPU delegate.
    onStatus && onStatus('GPU unavailable — falling back to CPU…');
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  }
  return landmarker;
}

// Seek a video element and resolve once the frame is actually ready to read.
function seek(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Could not read a frame from this video.')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = t;
  });
}

// Detect a pose track across the whole clip.
// Returns [{ timeMs, width, height, keypoints }] in the shape engine.js wants.
export async function detectSwing(video, { fps = 30, maxFrames = 90 } = {}, onProgress) {
  const lm = await initPose(onProgress);
  const dur = Math.max(0.2, video.duration || 0);
  const n = Math.min(maxFrames, Math.max(8, Math.round(dur * fps)));
  const W = video.videoWidth;
  const H = video.videoHeight;
  const frames = [];
  let lastTs = -1;

  for (let i = 0; i < n; i++) {
    // Clamp off the very end — seeking exactly to duration often never fires.
    const t = Math.min((dur * i) / (n - 1), dur - 0.03);
    await seek(video, Math.max(0, t));
    onProgress && onProgress(i + 1, n);

    // MediaPipe VIDEO mode demands strictly increasing millisecond timestamps.
    let ts = Math.round(t * 1000);
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    const res = lm.detectForVideo(video, ts);
    const lms = res.landmarks && res.landmarks[0];
    if (!lms) continue;

    const keypoints = {};
    for (const idx in LANDMARK_NAMES) {
      const l = lms[Number(idx)];
      if (!l) continue;
      keypoints[LANDMARK_NAMES[idx]] = {
        x: l.x * W,
        y: l.y * H,
        // MediaPipe z is normalized to roughly the same scale as x (by width),
        // so scaling by W keeps atan2(dz, dx) in the hip-rotation check honest.
        z: (l.z ?? 0) * W,
        score: l.visibility ?? 1,
      };
    }
    frames.push({ timeMs: Math.round(t * 1000), width: W, height: H, keypoints });
  }
  return frames;
}
