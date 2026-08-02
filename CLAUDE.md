# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Swing Coach Pro analyzes golf swing videos with pose detection and grades them against a per-body "ideal model". It is **two apps sharing one analysis engine**:

1. **Native app** (`App.js` + `src/`) — Expo 51 / React Native 0.74 dev-build app (not Expo Go — `react-native-fast-tflite` is a native module). BlazePose Full (33 landmarks) runs on-device via TFLite with GPU delegates.
2. **Web app** (`docs/`) — standalone vanilla-JS PWA, plain ES modules, **no build step and no dependencies**. Pose detection via MediaPipe Tasks Vision loaded from a CDN. Deployed to GitHub Pages straight from `docs/`.

The web app is the more feature-complete of the two (swing score, checkpoints table, coaching playback, practice plan, history, summary card, live stance check).

## Commands

```bash
npm test                          # engine test suite (jest-expo preset)
npx jest -t "name of test"        # run a single test by name
npx jest src/__tests__/analysis.test.js   # run one test file

# Web app — no build step, just serve docs/ (must be http://, not file://)
python3 -m http.server 8091 --directory docs

# Native app
npm run get-model                 # download the ~6MB BlazePose .tflite into assets/ (required once)
npm run ios / npm run android     # first build on device (needs Xcode / Android Studio)
npm start                         # day-to-day: expo start --dev-client
npm run web                       # Expo web preview — UI only, no pose detection on web
```

`.claude/launch.json` mirrors these as launch configs (`web-app` on port 8091, `expo-web` / `native-dev-client` on 8081).

## CI / deploy

`.github/workflows/deploy-pages.yml`: every push to `main` runs `npm test` and, only if green, deploys `docs/` to GitHub Pages. **A red test blocks the deploy** — the Jest suite is the gate for the web app even though it imports from `src/`.

## Architecture

### One engine, two copies — keep them in sync

The pure analysis engine lives in **two places that must not drift** for the logic they share:

- `src/idealModel.js` + `src/analysis.js` + `src/constants.js` — native original, covered by `src/__tests__/analysis.test.js`
- `docs/engine.js` — the same functions (`buildIdealModel`, `labelPhases`, `analyzeFrames`, `resolvePoint`, constants) ported verbatim into one ES module for the browser

`docs/engine.js` has since grown web-only additions (e.g. `measureCheckpoints`, scoring). When changing shared engine logic (thresholds, phase detection, fault definitions), change **both** files; the tests only exercise the `src/` copy.

The engine is pure functions over plain keypoint objects — `{ landmarkName: { x, y, z, score } }` in pixel units — and never touches a camera, model, or the DOM. Both pose backends (TFLite on device, MediaPipe in browser) normalize to this shape, then everything converges on `labelPhases` → `analyzeFrames`.

### Engine concepts

- **Ideal model** (`idealModel.js`): baseline angle ranges `[min, max]` in degrees, adjusted per body (height, BMI, ape index, age, flexibility) and club. Profile is always stored metric; imperial is a display-only conversion in the web UI.
- **Phases**: `setup → backswing → top → downswing → impact → follow-through → end`. The downswing anchor is the fastest *downward* wrist move (not the highest wrist — a full finish holds hands higher than the top). Nothing after `FOLLOW_WINDOW_MS` (1.2 s past impact) may add faults or move the score.
- **Faults**: objects with `id`, `label`, `tip`, `edges`, `circleAround`, `severity` (`'major'`/`'minor'`). Body sides are always **lead/trail** (derived from handedness), never hard-coded left/right.
- Every fault `id` needs a matching entry in `docs/drills.js` (`DRILLS` is keyed by fault id).

### Native app: platform split and two capture paths

Metro resolves `.web.js` ahead of `.js`, so `pose.web.js`, `videoFrames.web.js`, and `SwingCamera.web.js` shadow their native counterparts to keep TFLite/VisionCamera out of the web bundle. `src/constants.js` exists specifically so pure code can import `MIN_SCORE`/`LANDMARK_NAMES`/`EDGES` without dragging in the native stack — don't re-import them from `pose.js`.

Two input paths, converging on the same engine:
- **Live capture**: `SwingCamera.js` → `useSwingCapture.js` → `poseWorklet.js`. Runs on VisionCamera's frame-processor thread; worklet functions must carry the `'worklet'` directive and stay pure (no React state, no async). Frames never touch the JS thread; video records alongside and is only seeked afterwards for display frames.
- **Saved video**: `videoFrames.js` two-pass thumbnail pipeline — sample the whole clip, then densify the downswing — feeding `src/pose.js` (ROI-tracked crop → 256×256 → TFLite).

### Web app (`docs/`)

- `index.html` (markup + styles), `app.js` (all UI/state), `engine.js`, `pose.js` (MediaPipe wrapper), `drills.js`, `demo.js`, `sw.js`.
- MediaPipe's `detectForVideo` timestamp must be **monotonically increasing** — never rewind the clock across analyses (this caused a second-analysis crash; see `docs/pose.js`).
- `sw.js` is network-first with cache fallback (the site auto-deploys, so cache-first would pin stale code); bump the `CACHE` name when changing cached shell files.
- The MediaPipe runtime comes from a CDN, so the app needs a real web host — it cannot run as a claude.ai Artifact (sandbox blocks external hosts).

### Testing philosophy

Tests deliberately cover **only the engine** (geometry, phase labeling, fault thresholds) using synthetic skeletons built by a parameterized `body()` helper — no pose detection, camera, or worklet layers, so nothing needs mocking. `src/demoSwing.js` (native) and `docs/demo.js` (web) are hand-built swings with known faults for exercising the real pipeline without a device.
