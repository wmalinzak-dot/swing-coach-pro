# Swing Coach Pro — web app (`docs/`)

A browser version that analyzes a swing **video you upload**, marks the faulty
body parts on the video as they happen, and gives a drill for each. Runs
entirely client-side — the video never leaves the device.

## Features
- **Video analysis** — MediaPipe pose detection on an uploaded clip; faulty
  body parts drawn in red/amber during playback, with jump-to-fault buttons
- **Club & ball tracking** — the clubhead is followed through the swing from
  the pixels, drawn as a shaft and a fading arc, and turned into tempo, attack
  angle, low point, wrist lag and an estimated clubhead speed
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
- `clubTrack.js` — clubhead/ball tracking and the metrics from it (web-only)
- `drills.js` — a practice drill per fault
- `demo.js` — synthetic swing for the "no video handy" path

## How club tracking works
There is no club model to download — MediaPipe finds a body, not a 7-iron. The
clubhead is recovered from the picture instead, using two facts: through a
swing it is the fastest-moving thing in frame, and it is always about one club
length from the hands. Frame-to-frame motion, masked to an annulus around the
hands whose radius comes from your height and the club you picked, leaves the
clubhead as the strongest blob.

Motion is a *three*-frame difference — `min(|now−before|, |now−after|)`.
Differencing a single pair lights up both where the club is and the hole it
left behind, and at swing speed those two blobs are equally bright and far
apart, so the tracker would regularly lock onto a position the club had
already left.

The numbers then come off a circle fitted through the clubhead positions from
the downswing to just past impact, not off frame-to-frame deltas. At 30fps the
club moves the better part of a metre between samples and is a blurred streak,
so a raw delta gets the direction badly wrong. The fitted arc gives:

| Measurement | How it is read |
|---|---|
| Attack angle | the tangent to the arc at the impact position |
| Low point | the bottom of a circle is directly below its centre, so it is just `cx` |
| Clubhead speed | radius × angular velocity — the real arc, not a chord |
| Wrist lag | forearm-to-shaft angle at the halfway-down frame |
| Tempo | pure timing; needs no club at all, and survives slow-mo |

If the fit does not look like a golf swing (wrong radius, centre below the
clubhead) the arc-derived numbers are withheld rather than guessed, and the
faults that depend on them never fire. Tempo, which needs no pixels, still
reports.

The ball is looked for once, at address, as a bright blob where your stance and
club say it should be. When the picture does not offer a convincing one, the
stance estimate is used and the UI says so — the low point is then measured
against an assumption, which is worth knowing.

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
- **Club tracking wants a clean background.** It is a motion tracker, so
  anything else moving in frame at roughly one club length from the hands —
  a playing partner, blowing branches, a busy range behind you — competes with
  the club. A plain backdrop and decent light are what make it work.
- **The clubhead has to stay in frame.** Wide-angle or a step back; if the club
  leaves the picture at the top there is nothing to follow.
- **Clubhead speed reads low.** It is measured from a 2D face-on arc, so any
  movement toward or away from the camera is invisible to it, and a 30fps
  sample misses the true peak. Useful for tracking yourself over time, not for
  arguing with a launch monitor. Slow-mo clips suppress it entirely, since
  wall-clock speed there is meaningless — tempo, being a ratio, is unaffected.
- The club thresholds have the same caveat as the body ones: they are set from
  published teaching numbers and want tuning against real footage.
- Best with MP4/H.264, face-on, whole body in frame, good light. iPhone HEVC
  `.mov` files decode in Safari and usually in Chrome-on-macOS, but not in every
  Chromium build; the app now shows a clear message and suggests Safari or
  exporting "Most Compatible"/MP4 when a video won't decode.
- Browser landmark positions won't match the native TFLite build exactly, so
  fault thresholds may need a little tuning against real footage.
