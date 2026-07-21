# Swing Coach Pro (dev build — BlazePose GPU)

The "best overall" version: BlazePose Full (33 landmarks incl. feet, GPU-accelerated
via CoreML/Android GPU delegates), two-pass frame sampling that zooms into the
downswing to catch impact, ROI person-tracking between frames, and z-depth hip
rotation measurement.

## Requires a development build (not Expo Go)
react-native-fast-tflite is a native module, so you build the app once with
Expo's tooling, then develop exactly like before.

```bash
npx create-expo-app swing-coach-pro --template blank
cd swing-coach-pro
# replace App.js, app.json, package.json, metro.config.js and copy src/ + assets/

npx expo install expo-dev-client expo-image-picker expo-video-thumbnails expo-file-system expo-image-manipulator react-native-svg
npm install react-native-fast-tflite jpeg-js buffer
npm install react-native-vision-camera react-native-worklets-core vision-camera-resize-plugin

# download the BlazePose model (~6 MB) into assets/
npm run get-model

# build & run on your device (Mac + Xcode for iOS, Android Studio for Android)
npx expo run:ios --device      # or: npx expo run:android
```
After the first build, day-to-day dev is just `npx expo start --dev-client`.

No Mac? `eas build --profile development --platform ios` builds it in the cloud.

## What's better than the Expo Go version
| | Expo Go (v1) | Pro (v2) |
|---|---|---|
| Model | MoveNet Lightning, 17 pts | BlazePose Full, 33 pts (feet + depth) |
| Compute | CPU (tfjs) | GPU (CoreML / Android GPU) |
| Frames | 9 fixed | 16 + 8 extra zoomed into the downswing |
| Impact detection | nearest frame after top | wrist-velocity refined |
| Hip rotation | 2D hip-line proxy | true z-depth angle |
| New faults | — | knee sway, flat trail foot, balance via heels/toes |
| Person tracking | none | ROI tracked frame-to-frame (MediaPipe-style) |

## Two ways in
**Record a swing (live)** — VisionCamera frame processor. Frames go camera →
native resize → BlazePose → landmarks without ever touching the JS thread, so
you get pose data at full frame rate and see the skeleton lock on before you
swing. Video records alongside; afterwards we seek it only for the handful of
key frames we display.

**Pick a saved video** — the original two-pass thumbnail pipeline. Slower
(disk round-trip + JS JPEG decode per frame) but it's the only way to analyze
slow-mo clips you already shot, and 240fps footage still gives the sharpest
impact frame.

Both paths converge on the same `labelPhases` → `analyzeFrames` code.

## Tips for best input video
- Face-on (camera pointing at your chest), tripod or steady hand
- Whole body in frame the entire swing, decent light
- **Slow-mo (120/240fps) clips are ideal** — more real frames at impact
