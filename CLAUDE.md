# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A golf swing analyzer that scores a user's swing against a personalized "ideal model" built from their body (height, weight, wingspan, age, flexibility, club). There are **two apps in one repo**:

1. **Native Expo app** (`App.js` + `src/`) — React Native dev build (not Expo Go; `react-native-fast-tflite` is a native module). BlazePose Full (33 landmarks) runs on-device via TFLite with GPU delegates.
2. **Web app** (`docs/`) — a completely separate, build-step-free vanilla-JS ES-module app served as static files and deployed to GitHub Pages. Pose detection uses MediaPipe Tasks Vision loaded from a CDN.

## Commands

```bash
npm test                                   # jest (jest-expo preset) — the engine test suite
npx jest -t "name of test"                 # run a single test by name
npm run web                                # Expo web preview on :8081 (demo swing only — no pose detection)
npm start                                  # expo start --dev-client (day-to-day native dev)
npm run ios / npm run android              # build & run on device (needs Xcode / Android Studio)
npm run get-model                          # download the BlazePose .tflite (~6 MB) into assets/

# Web app (docs/) — must be served over http, not opened as file://
python3 -m http.server 8091 --directory docs
```

`.claude/launch.json` has launch configs for all three (`web-app`, `expo-web`, `native-dev-client`).

## CI

`.github/workflows/deploy-pages.yml` runs `npm test` and then deploys `docs/` to GitHub Pages on every push to `main`. **A red test blocks the deploy.**

## Architecture

### The pure analysis engine (the heart of everything)

- `src/idealModel.js` — `buildIdealModel(profile)` turns body measurements into per-person angle target ranges (degrees).
- `src/analysis.js` — `labelPhases(frames, handedness)` finds setup/top/impact/finish from wrist trajectory, then `analyzeFrames(labeled, ideal)` scores faults per frame. Nothing after `FOLLOW_WINDOW_MS` (1.2 s past impact) may add faults or move the score.
- `src/constants.js` — `LANDMARK_NAMES`, `EDGES`, `MIN_SCORE`. Deliberately split out of `pose.js` so web and worklet code can import constants without dragging in native modules.

These are **pure functions over plain objects**: they only ever see keypoints shaped `{ name: { x, y, z, score } }` in pixel units, so they run identically on device, in the browser, and in Node under jest.

### CRITICAL: `docs/engine.js` is a verbatim port

`docs/engine.js` contains `buildIdealModel` / `labelPhases` / `analyzeFrames` / `resolvePoint` ported verbatim from `src/idealModel.js` + `src/analysis.js`. **Any change to the engine in `src/` must be mirrored in `docs/engine.js` (and vice versa).** The jest suite only imports the `src/` copies, so parity is maintained by hand — do not let them drift.

### Native app: two capture paths, one engine

Both paths converge on `labelPhases` → `analyzeFrames` (orchestrated in `App.js`):

- **Live capture** — `SwingCamera.js` → `useSwingCapture.js` → `poseWorklet.js`. Frames flow camera → native resize (`vision-camera-resize-plugin`) → TFLite → landmarks entirely on VisionCamera's frame-processor thread; the JS thread is never touched. Video records alongside, and afterwards `extractFramesAt` seeks it only for the key frames displayed. Everything in `poseWorklet.js` runs on the frame-processor thread: each exported function needs the `'worklet'` directive and must stay pure (no React state, no async).
- **Saved video** — `videoFrames.js` + `pose.js`. Two-pass: sample the whole clip (16 frames), find the top of the swing, then re-sample the downswing at double density (8 more) to catch impact. `pose.js` is the slower still-image pipeline (ROI crop → resize → JS JPEG decode → TFLite) with ROI person-tracking between frames — call `resetTracking()` before each new video.

### Platform forks (Metro `.web.js` resolution)

`pose.web.js`, `videoFrames.web.js`, and `SwingCamera.web.js` shadow their native counterparts in the web build, keeping TFLite/VisionCamera out of the browser bundle. They throw "needs the native build" — the Expo web preview exists only to exercise the UI and the engine via the demo swing.

### Synthetic swings

`src/demoSwing.js` (and `docs/demo.js`) hand-build skeletons with known, deliberate faults and drive the real `labelPhases` → `analyzeFrames` path. This is how the UI is checked without filming anything, and the same technique the test suite uses.

### Web app (`docs/`)

- `index.html` (markup + styles), `app.js` (UI, video overlay, results, ~all features), `engine.js` (ported engine), `pose.js` (MediaPipe wrapper), `drills.js` (a named practice drill per fault id), `demo.js`, `sw.js` (offline app-shell), `manifest.webmanifest` (PWA).
- Features live in `docs/app.js`: swing score, checkpoints table, slow-mo coaching playback, strictness modes, practice plan, on-device progress history (`localStorage`), summary card, live stance check, suggestion box (mailto).
- **Units**: the engine thinks in cm/kg; the web UI displays imperial (ft-in/lb) by default with a metric toggle — conversion happens at the form boundary only.
- **MediaPipe clock**: timestamps passed to the landmarker must increase for its lifetime, never per analysis. `docs/pose.js` keeps one forever-increasing `mpClock`; a poisoned graph cannot be revived and must be rebuilt. Don't reset it.
- Cannot be published as a claude.ai Artifact — the sandbox blocks the CDN-hosted MediaPipe runtime. It needs a real static host.

## Testing conventions

`src/__tests__/analysis.test.js` covers geometry, phase labeling, and fault thresholds using synthetic skeletons (the `body()` helper drives each fault threshold precisely — e.g. `kneeOffsetPx: 26` ≈ a 160° knee angle). It deliberately covers **none** of the pose detection, camera, or worklet layers — those need a device. Keep new engine tests in this style: pure keypoints in, faults out, every landmark scored above `MIN_SCORE` unless the test is about visibility gating.

## Gotchas

- The TFLite model (`assets/pose_landmark_full.tflite`) is fetched by `npm run get-model`; live capture loads it via `require('../assets/pose_landmark_full.tflite')`.
- Fault thresholds in the web app may need tuning against real footage — browser landmark positions don't exactly match the native TFLite build.
- Keypoint names are MoveNet-compatible (`left_wrist`, `right_hip`, …) plus BlazePose-only feet landmarks (`left_heel`, `right_foot_index`, …); only the 17 named indices in `LANDMARK_NAMES` are kept out of BlazePose's 33.
