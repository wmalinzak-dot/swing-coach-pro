// Live swing capture on the frame-processor thread.
//
// The whole point: `resize()` gives us model-ready pixels natively, so a frame
// goes camera → tensor → 33 landmarks without ever leaving native memory or
// blocking the JS thread. The still-image pipeline in pose.js spends 100-300ms
// per frame on a disk round-trip and a pure-JS JPEG decode; this spends none.
//
// We record video at the same time, but only to pull back the handful of key
// frames we actually display — the pose data is already done by then.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useFrameProcessor } from 'react-native-vision-camera';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { Worklets } from 'react-native-worklets-core';
import { Platform } from 'react-native';

import { INPUT, decodeLandmarks, readOutputs, roiFromLandmarks, squareRoi } from './poseWorklet';

// Below this pose-presence score we assume the body left the frame and drop
// ROI tracking, so the next frame re-detects from a full-frame center crop.
const TRACK_DROP = 0.5;

export function useSwingCapture() {
  const delegate = Platform.OS === 'ios' ? 'core-ml' : 'android-gpu';
  const tflite = useTensorflowModel(require('../assets/pose_landmark_full.tflite'), delegate);
  const { resize } = useResizePlugin();

  // Shared between the JS and frame-processor threads. These must survive
  // re-renders — recreating them would reset ROI tracking mid-swing and leave
  // the frame processor holding a stale `collecting` flag.
  const lastRoi = useMemo(() => Worklets.createSharedValue(null), []);
  const collecting = useMemo(() => Worklets.createSharedValue(false), []);

  const [liveKeypoints, setLiveKeypoints] = useState(null);
  const posesRef = useRef([]);
  const wallClockRef = useRef({ start: 0, end: 0 });

  // Called from the worklet for every successful detection.
  const onPose = useCallback((kp, rawTs, frameW, frameH, isCollecting) => {
    setLiveKeypoints({ keypoints: kp, width: frameW, height: frameH });
    if (isCollecting) {
      posesRef.current.push({ keypoints: kp, rawTs, width: frameW, height: frameH });
    }
  }, []);

  const pushPose = useMemo(() => Worklets.createRunOnJS(onPose), [onPose]);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      const model = tflite.model;
      if (model == null) return;

      // Track the body between frames; fall back to a full-frame center square.
      const roi =
        lastRoi.value ??
        squareRoi(
          frame.width,
          frame.height,
          frame.width / 2,
          frame.height / 2,
          Math.min(frame.width, frame.height)
        );

      // Native crop + resize straight out of the camera buffer.
      const pixels = resize(frame, {
        crop: { x: roi.x, y: roi.y, width: roi.size, height: roi.size },
        scale: { width: INPUT, height: INPUT },
        pixelFormat: 'rgb',
        dataType: 'float32',
      });

      // The plugin yields 0-255 floats; BlazePose wants 0-1.
      const input = new Float32Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) input[i] = pixels[i] / 255;

      const { ld, flag } = readOutputs(model.runSync([input]));
      if (ld == null) return;

      const kp = decodeLandmarks(ld, roi, flag);
      lastRoi.value = flag > TRACK_DROP ? roiFromLandmarks(kp, frame.width, frame.height) : null;

      if (flag > 0.3) {
        pushPose(kp, frame.timestamp, frame.width, frame.height, collecting.value);
      }
    },
    [tflite, resize, pushPose]
  );

  const startCollecting = useCallback(() => {
    posesRef.current = [];
    lastRoi.value = null;
    wallClockRef.current.start = Date.now();
    collecting.value = true;
  }, [lastRoi, collecting]);

  // Frame timestamps are monotonic but their unit differs by platform, so we
  // self-calibrate: scale the raw span onto the wall-clock recording duration.
  // The downstream analysis only ever uses relative ms, so this is exact enough
  // for the wrist-velocity impact refinement.
  const stopCollecting = useCallback(() => {
    collecting.value = false;
    wallClockRef.current.end = Date.now();

    const raw = posesRef.current;
    if (raw.length < 2) return [];

    const first = raw[0].rawTs;
    const span = raw[raw.length - 1].rawTs - first;
    const wallMs = wallClockRef.current.end - wallClockRef.current.start;
    const scale = span > 0 ? wallMs / span : 1;

    return raw.map((p) => ({
      keypoints: p.keypoints,
      width: p.width,
      height: p.height,
      timeMs: Math.round((p.rawTs - first) * scale),
    }));
  }, [collecting]);

  return {
    frameProcessor,
    liveKeypoints,
    startCollecting,
    stopCollecting,
    modelState: tflite.state, // 'loading' | 'loaded' | 'error'
    modelError: tflite.error,
  };
}
