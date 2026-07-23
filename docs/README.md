# Swing Coach Pro — web app (`docs/`)

A browser version that analyzes a swing **video you upload**, marks the faulty
body parts on the video as they happen, and gives a drill for each. Runs
entirely client-side — the video never leaves the device.

## Features
- **Video analysis** — MediaPipe pose detection on an uploaded clip; faulty
  body parts drawn in red/amber during playback, with jump-to-fault buttons
- **Checkpoints table** — your measured angles next to your personal targets
- **Swing Score** — 0–100 with a letter grade, severity-weighted
- **Coaching playback** — ¼×/½× slow-mo, frame stepping, jump-to-phase chips
- **Strictness modes** — relaxed / normal / strict grading thresholds
- **Practice plan** — top-3 priorities with named drills, printable
- **Progress history** — past scores + trend sparkline, stored only on-device
- **Summary card** — downloadable PNG scorecard
- **PWA** — installable, app shell works offline (pose detection still needs
  the network for the CDN runtime)

## How it differs from the native app
| | Native app | This web app |
|---|---|---|
| Pose detection | BlazePose via TFLite (GPU) | BlazePose via **MediaPipe Tasks Vision** (WebGL), loaded from a CDN |
| Input | live camera + saved video | uploaded video file |
| Analysis engine | `src/analysis.js` | `docs/engine.js` — the same functions, ported verbatim |
| Hosting | app store / dev build | any static host (GitHub Pages) |

The analysis engine and the personalized ideal-model math are identical to the
native app; only the pose-detection and view layers are re-implemented for the
browser.

## Files
- `index.html` — markup + styles
- `app.js` — UI, video overlay, results
- `engine.js` — ported analysis engine (pure functions)
- `pose.js` — MediaPipe wrapper (browser pose detection)
- `drills.js` — a practice drill per fault
- `demo.js` — synthetic swing for the "no video handy" path

## Run locally
```bash
cd docs
python3 -m http.server 8091
# open http://localhost:8091
```
Must be served over http(s), not opened as a `file://` — ES modules require it.

## Deploy (GitHub Pages)
A workflow is included (`.github/workflows/deploy-pages.yml`) that runs the
engine test suite and deploys `docs/` on every push to `main`.

1. Push the repo to GitHub.
2. **Settings → Pages → Source → "GitHub Actions"** (one-time).
3. Every push to `main` now tests and deploys automatically.
   The URL is `https://<user>.github.io/<repo>/`.

(The manual alternative still works: Source → "Deploy from a branch" →
`main` / `/docs` — but then nothing gates deploys on the tests.)

## Known limits
- Needs a normal web host — a claude.ai Artifact's sandbox blocks the MediaPipe
  runtime, so this cannot be published as an Artifact.
- Best with MP4/H.264, face-on, whole body in frame, good light. iPhone HEVC
  `.mov` files decode in Safari and usually in Chrome-on-macOS, but not in every
  Chromium build; the app now shows a clear message and suggests Safari or
  exporting "Most Compatible"/MP4 when a video won't decode.
- Browser landmark positions won't match the native TFLite build exactly, so
  fault thresholds may need a little tuning against real footage.
