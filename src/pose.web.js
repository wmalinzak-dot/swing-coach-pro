// Web build of pose.js. Metro resolves .web.js ahead of .js for the web
// platform, so this shadows the native file and keeps TFLite out of the
// browser bundle entirely.
//
// There is no on-device pose detection here: react-native-fast-tflite is a
// native module. The web build exists to preview the UI and to exercise the
// analysis engine against known poses — see demoSwing.js.

export { LANDMARK_NAMES, EDGES, MIN_SCORE } from './constants';

const unavailable = (what) => {
  throw new Error(
    `${what} needs the native build — react-native-fast-tflite does not run in a browser. ` +
      `Use the demo swing to preview the analysis, or build with EAS to run it for real.`
  );
};

export async function initPose() {
  unavailable('BlazePose');
}

export async function detectFrame() {
  unavailable('Pose detection');
}

export function resetTracking() {
  // No tracking state on web — safe to call, does nothing.
}
