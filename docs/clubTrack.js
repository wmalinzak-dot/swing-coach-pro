// Clubhead and ball tracking, and the metrics that fall out of them.
//
// MediaPipe finds a *body*, not a club, so the clubhead has to come from the
// pixels. The idea that makes it tractable: through a swing the clubhead is
// (a) the fastest-moving thing in the frame and (b) always about one club
// length from the hands. Intersect those two facts — frame-to-frame motion,
// masked to an annulus centred on the hands — and the clubhead falls out
// without a second model to download.
//
// Everything downstream then hangs off one more observation: near impact the
// clubhead travels on a circle. Fitting that circle is what makes the numbers
// trustworthy at 30fps, where the club moves a metre between frames and is a
// blurred streak. From the fitted arc we read:
//   • attack angle  — the tangent direction at the impact position
//   • low point     — the bottom of a circle is directly below its centre
//   • speed         — radius × angular velocity (an arc, not a chord)
// A raw frame-to-frame difference would get all three badly wrong.
//
// Web-only. The native app's frames arrive as JPEG URIs with no cheap pixel
// access on the JS thread, so this has no counterpart in src/ yet.
//
// Everything except sampleGray/sampleGrayRegion is pure — no DOM, no canvas —
// which is what lets src/__tests__/clubTrack.test.js run it under Node.

const MIN_SCORE = 0.5;

// Playing length, butt to sole, in cm. Used with the player's height to turn
// "one club length" into pixels, so the search annulus adapts to body size,
// camera distance and club in one step.
export const CLUB_LENGTH_CM = { driver: 114, iron: 95, wedge: 89 };

// The hands sit a few inches down from the butt end, so the hands→clubhead
// distance is a little shorter than the club itself.
const GRIP_FACTOR = 0.9;

// Nose-to-ankle as a fraction of standing height — the scale reference that
// converts pixels to centimetres.
const NOSE_TO_ANKLE = 0.855;

// Working resolution for motion tracking. Small is good: it blurs sensor
// noise into nothing, and the clubhead streak is still several pixels wide.
export const TRACK_W = 192;

const MOTION_FLOOR = 14; // 0–255 grey difference that counts as movement
const CM_S_TO_MPH = 0.02236936;

// A swing takes about a second. Anything much longer is a slow-mo clip, where
// wall-clock speed is meaningless (the ratio-based tempo number survives).
const SLOWMO_MS = 2400;

const P = (kp, name) => (kp && kp[name] && kp[name].score >= MIN_SCORE ? kp[name] : null);
const midPt = (a, b) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Frame sampling (browser only — the two functions that touch a canvas)
// ---------------------------------------------------------------------------

let scratch = null;
function scratchCtx(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch.getContext('2d', { willReadFrequently: true });
}

function toGrey(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Integer luma — the same weights as Rec.601, kept off the float path
    // because this runs once per pixel per frame.
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

// Whole frame, downscaled to TRACK_W, as 8-bit grey.
export function sampleGrey(video, trackW = TRACK_W) {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return null;
  const w = trackW;
  const h = Math.max(1, Math.round((H / W) * trackW));
  const g = scratchCtx(w, h);
  g.drawImage(video, 0, 0, w, h);
  return { data: toGrey(g.getImageData(0, 0, w, h).data, w * h), w, h };
}

// A rectangle of the frame at high resolution — a golf ball is 2px wide in the
// TRACK_W image but ~8px in a crop, which is the difference between finding it
// and not.
export function sampleGreyRegion(video, rect, outW = 256) {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return null;
  const sx = clamp(Math.round(rect.x), 0, W - 2);
  const sy = clamp(Math.round(rect.y), 0, H - 2);
  const sw = clamp(Math.round(rect.w), 2, W - sx);
  const sh = clamp(Math.round(rect.h), 2, H - sy);
  const w = Math.min(outW, sw);
  const h = Math.max(1, Math.round((sh / sw) * w));
  const g = scratchCtx(w, h);
  g.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  return {
    data: toGrey(g.getImageData(0, 0, w, h).data, w * h),
    w, h, sx, sy, scale: w / sw,
  };
}

// ---------------------------------------------------------------------------
// Scale, ball position
// ---------------------------------------------------------------------------

// Pixels per centimetre, from the player's own height. This is what lets the
// tracker work at any camera distance without a calibration step.
export function estimatePxPerCm(frames, profile) {
  for (const f of frames) {
    const kp = f.keypoints;
    const nose = P(kp, 'nose');
    const ankles = midPt(P(kp, 'left_ankle'), P(kp, 'right_ankle'));
    if (!nose || !ankles) continue;
    const px = Math.abs(ankles.y - nose.y);
    const cm = (profile.heightCm || 178) * NOSE_TO_ANKLE;
    if (px > 20 && cm > 0) return px / cm;
  }
  return null;
}

// Which way the target is, in screen x. Derived from the stance rather than
// assumed, so it holds for either handedness and a mirrored camera.
export function targetDirection(kp, handedness) {
  const lead = handedness === 'right' ? 'left' : 'right';
  const trail = handedness === 'right' ? 'right' : 'left';
  const l = P(kp, `${lead}_ankle`), t = P(kp, `${trail}_ankle`);
  if (!l || !t || Math.abs(l.x - t.x) < 1) return 1;
  return Math.sign(l.x - t.x);
}

// Where the ball should be for this club, from the stance. Ball position moves
// back through the bag: off the lead heel for a driver, middle for a wedge.
const BALL_FRACTION = { driver: 0.85, iron: 0.35, wedge: 0.05 };

export function estimateBallPoint(kp, profile) {
  const lead = profile.handedness === 'right' ? 'left' : 'right';
  const trail = profile.handedness === 'right' ? 'right' : 'left';
  const leadAnkle = P(kp, `${lead}_ankle`);
  const trailAnkle = P(kp, `${trail}_ankle`);
  if (!leadAnkle || !trailAnkle) return null;
  const midX = (leadAnkle.x + trailAnkle.x) / 2;
  const f = BALL_FRACTION[profile.club] ?? 0.35;
  // The sole of the foot, not the ankle joint, is the ground line.
  const toes = [P(kp, `${lead}_foot_index`), P(kp, `${trail}_foot_index`),
    P(kp, `${lead}_heel`), P(kp, `${trail}_heel`)].filter(Boolean);
  const groundY = toes.length
    ? Math.max(...toes.map((p) => p.y))
    : Math.max(leadAnkle.y, trailAnkle.y) + Math.abs(leadAnkle.x - trailAnkle.x) * 0.15;
  return { x: midX + (leadAnkle.x - midX) * f, y: groundY, score: 0.4, estimated: true };
}

// Look for the ball itself: a small bright blob against the turf, inside the
// window where the stance says it should be. Scored as centre-minus-ring
// brightness (a top-hat), which finds a ball but ignores a bright background.
export function findBallInPatch(patch, expected, searchPx) {
  if (!patch) return null;
  const { data, w, h, sx, sy, scale } = patch;
  const cx = (expected.x - sx) * scale;
  const cy = (expected.y - sy) * scale;
  const rad = Math.max(2, Math.round(searchPx * scale));
  const at = (x, y) => data[y * w + x];

  // Ball radius in patch pixels — a 4.3cm ball at this crop's scale.
  const br = clamp(Math.round(patch.ballRadiusPx || 3), 2, 6);
  let best = null;
  const x0 = clamp(Math.round(cx - rad), br + 1, w - br - 2);
  const x1 = clamp(Math.round(cx + rad), br + 1, w - br - 2);
  const y0 = clamp(Math.round(cy - rad), br + 1, h - br - 2);
  const y1 = clamp(Math.round(cy + rad), br + 1, h - br - 2);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let core = 0, coreN = 0, ring = 0, ringN = 0;
      for (let dy = -br - 2; dy <= br + 2; dy++) {
        for (let dx = -br - 2; dx <= br + 2; dx++) {
          const d = Math.hypot(dx, dy);
          const v = at(x + dx, y + dy);
          if (d <= br) { core += v; coreN++; }
          else if (d <= br + 2) { ring += v; ringN++; }
        }
      }
      if (!coreN || !ringN) continue;
      const contrast = core / coreN - ring / ringN;
      if (!best || contrast > best.contrast) best = { x, y, contrast };
    }
  }
  // A ball on turf is emphatically brighter than what surrounds it. Below this
  // we are chasing texture, and a wrong ball is worse than an assumed one.
  if (!best || best.contrast < 22) return null;
  return {
    x: sx + best.x / scale,
    y: sy + best.y / scale,
    score: 0.9,
    estimated: false,
    contrast: Math.round(best.contrast),
  };
}

// Find the ball in the address frame. The caller must already have the video
// seeked there. Falls back to the stance-based estimate whenever the picture
// doesn't offer a convincing blob — an assumed ball is honest, a wrong one
// silently poisons the low-point number.
export function findBall(video, setupFrame, ideal) {
  const expected = estimateBallPoint(setupFrame.keypoints, ideal.profile);
  if (!expected) return null;
  const pxPerCm = estimatePxPerCm([setupFrame], ideal.profile);
  if (!pxPerCm) return expected;

  const searchPx = 25 * pxPerCm; // look within ~25cm of where the stance says
  const patch = sampleGreyRegion(video, {
    x: expected.x - searchPx * 1.4, y: expected.y - searchPx,
    w: searchPx * 2.8, h: searchPx * 2,
  });
  if (!patch) return expected;
  patch.ballRadiusPx = 2.13 * pxPerCm * patch.scale; // a golf ball is 4.27cm across
  return findBallInPatch(patch, expected, searchPx) || expected;
}

// ---------------------------------------------------------------------------
// Clubhead tracking
// ---------------------------------------------------------------------------

// Body parts whose own motion could out-shout the club. Knees, ankles and feet
// are deliberately absent: at impact the clubhead is right down among them,
// and masking there would blind the tracker exactly where it matters most.
const MASKED = ['nose', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip',
  'left_elbow', 'right_elbow'];

// Score one frame's motion map for the most club-like blob.
//
// weight = motion × how close to one club length from the hands
//                 × a soft bonus for being near where the club was heading
// The bonus is soft (never below 1) on purpose: between two frames at impact
// the clubhead can move further than the club is long, and a hard continuity
// term would refuse to follow it.
//
// Motion is a three-frame difference — min(|now−before|, |now−after|) — not a
// two-frame one. Differencing a pair lights up both where the club is AND the
// hole it left behind, and with a fast club those two blobs are far apart and
// equally bright, so the tracker has a coin-flip's chance of locking onto a
// position the club already left. Only the current position is bright in both
// differences, so the minimum keeps it and cancels the ghost.
function scanFrame(grey, prev, next, hands, radius, predicted, masks, scale) {
  const { data, w, h } = grey;
  const pd = prev.data;
  const nd = next ? next.data : null;
  // Everything in this function works in track-resolution pixels; `radius`
  // arrives in full-resolution ones.
  const R = radius * scale;
  const sigma = 0.22 * R;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const pSigma = 0.5 * R;
  const invP = 1 / (2 * pSigma * pSigma);
  const rMin = 0.55 * R, rMax = 1.4 * R;
  const hx = hands.x * scale, hy = hands.y * scale;

  let bestW = 0, bestX = 0, bestY = 0, total = 0;
  const weights = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const motion = nd
        ? Math.min(Math.abs(data[i] - pd[i]), Math.abs(data[i] - nd[i]))
        : Math.abs(data[i] - pd[i]);
      if (motion < MOTION_FLOOR) continue;
      const dx = x - hx, dy = y - hy;
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) continue;
      let masked = false;
      for (const m of masks) {
        if ((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y) < m.r2) { masked = true; break; }
      }
      if (masked) continue;
      const dr = r - R;
      let wgt = motion * Math.exp(-dr * dr * inv2s2);
      if (predicted) {
        const px = predicted.x * scale, py = predicted.y * scale;
        const dp2 = (x - px) * (x - px) + (y - py) * (y - py);
        wgt *= 1 + 1.2 * Math.exp(-dp2 * invP);
      }
      weights[i] = wgt;
      total += wgt;
      if (wgt > bestW) { bestW = wgt; bestX = x; bestY = y; }
    }
  }
  if (!bestW || !total) return null;

  // Centroid of the blob around the peak. With motion blur the club is a
  // streak; its centroid is the mid-exposure position, which is what we want.
  const win = Math.max(2, Math.round(0.14 * R));
  let sw = 0, sx = 0, sy = 0;
  for (let y = Math.max(0, bestY - win); y <= Math.min(h - 1, bestY + win); y++) {
    for (let x = Math.max(0, bestX - win); x <= Math.min(w - 1, bestX + win); x++) {
      const wg = weights[y * w + x];
      if (!wg) continue;
      sw += wg; sx += wg * x; sy += wg * y;
    }
  }
  if (!sw) return null;
  return {
    x: (sx / sw) / scale,
    y: (sy / sw) / scale,
    // How much of the frame's total club-like motion sits in this one blob.
    // A single clear clubhead scores high; scattered background motion doesn't.
    conf: clamp(sw / total, 0, 1),
  };
}

// Track the clubhead across a swing. `frames` must carry `.grey` (see
// sampleGrey); the tracked point is written back as a `clubhead` keypoint so
// the existing overlay, resolvePoint and fault plumbing handle it unchanged.
export function trackClubhead(frames, ideal, ball) {
  const profile = ideal.profile;
  const pxPerCm = estimatePxPerCm(frames, profile);
  const usable = frames.filter((f) => f.grey);
  if (!pxPerCm || usable.length < 3) return { pxPerCm, radiusPx: null, tracked: 0 };

  const clubCm = CLUB_LENGTH_CM[profile.club] ?? CLUB_LENGTH_CM.iron;
  const radius = clubCm * GRIP_FACTOR * pxPerCm;
  const scale = usable[0].grey.w / usable[0].width;
  const maskR = 0.14 * radius * scale;

  // Indices of the frames that actually carry a picture. Working through this
  // list rather than the raw frames keeps the before/after pair meaningful
  // even if a frame in the middle failed to sample.
  const shot = [];
  frames.forEach((f, i) => { if (f.grey) shot.push(i); });

  let prevPt = null, prevPrevPt = null, tracked = 0;

  for (let j = 1; j < shot.length; j++) {
    const f = frames[shot[j]];
    const kp = f.keypoints;
    const hands = midPt(P(kp, 'left_wrist'), P(kp, 'right_wrist'))
      || P(kp, 'left_wrist') || P(kp, 'right_wrist');
    if (!hands) continue;

    const masks = MASKED.map((n) => P(kp, n)).filter(Boolean)
      .map((p) => ({ x: p.x * scale, y: p.y * scale, r2: maskR * maskR }));
    // Constant-velocity guess at where the clubhead went next.
    const predicted = prevPt && prevPrevPt
      ? { x: 2 * prevPt.x - prevPrevPt.x, y: 2 * prevPt.y - prevPrevPt.y }
      : prevPt;

    const hit = scanFrame(
      f.grey, frames[shot[j - 1]].grey,
      j + 1 < shot.length ? frames[shot[j + 1]].grey : null,
      hands, radius, predicted, masks, scale
    );
    if (!hit || hit.conf < 0.12) continue;
    f.keypoints.clubhead = { x: hit.x, y: hit.y, z: 0, score: clamp(hit.conf * 2, 0, 1) };
    prevPrevPt = prevPt;
    prevPt = hit;
    tracked++;
  }

  // The address frame has no motion to look at, but it is the one frame where
  // the clubhead's position is known from geometry: it is sitting at the ball.
  const setup = frames[0];
  if (setup && !setup.keypoints.clubhead) {
    const hands = midPt(P(setup.keypoints, 'left_wrist'), P(setup.keypoints, 'right_wrist'));
    const target = ball || estimateBallPoint(setup.keypoints, profile);
    if (hands && target) {
      const dx = target.x - hands.x, dy = target.y - hands.y;
      const d = Math.hypot(dx, dy) || 1;
      setup.keypoints.clubhead = {
        x: hands.x + (dx / d) * radius, y: hands.y + (dy / d) * radius, z: 0, score: 0.5,
      };
    }
  }
  return { pxPerCm, radiusPx: radius, tracked };
}

// ---------------------------------------------------------------------------
// Ball flight (the tracer)
// ---------------------------------------------------------------------------

// How many frames after impact to keep looking. Past this the ball is either
// gone from frame or too small to separate from noise.
const MAX_FLIGHT_FRAMES = 12;

// Frame-to-frame travel is what decides whether a tracer is possible at all.
// A driver leaves at ~150mph; in a frame that frames a golfer, that is about
// one whole frame width per 1/30s — the ball is simply gone on the next
// sample. At 120/240fps it moves a quarter or an eighth of that and there is
// a real flight to follow, which is why this is a slow-mo feature and says so
// rather than drawing a confident arc through one point.
const MIN_TRACER_POINTS = 2;

// Follow the ball off the face. Returns the points it found; they are also
// written onto the frames as `ball` keypoints flagged `flight`, so the overlay
// and the metrics read them the same way they read everything else.
export function trackBallFlight(frames, ideal, ballAt, impactIdx) {
  const out = { points: [], lost: null, quality: 'none' };
  if (!ballAt || impactIdx == null || impactIdx < 0) return out;

  const shot = [];
  frames.forEach((f, i) => { if (f.grey) shot.push(i); });
  const start = shot.indexOf(impactIdx);
  if (start < 0 || shot.length - start < 3) return out;

  const g0 = frames[shot[0]].grey;
  const scale = g0.w / frames[shot[0]].width;
  const pxPerCm = estimatePxPerCm(frames, ideal.profile);
  const dir = targetDirection(frames[impactIdx].keypoints, ideal.profile.handedness);

  // Body and club are the two other fast-moving things in the picture. The
  // ball has to be separated from both or the tracer just follows the club.
  const maskNames = Object.keys(LANDMARK_MASK_RADIUS);
  const bodyPx = pxPerCm ? (ideal.profile.heightCm || 178) * NOSE_TO_ANKLE * pxPerCm : 400;

  let prev = { x: ballAt.x, y: ballAt.y };
  let vel = null;

  for (let j = start + 1; j < shot.length && j - start <= MAX_FLIGHT_FRAMES; j++) {
    const f = frames[shot[j]];
    const kp = f.keypoints;
    const masks = maskNames.map((n) => {
      const p = P(kp, n);
      if (!p) return null;
      const r = LANDMARK_MASK_RADIUS[n] * bodyPx * scale;
      return { x: p.x * scale, y: p.y * scale, r2: r * r };
    }).filter(Boolean);
    if (kp.clubhead) {
      const r = 0.12 * bodyPx * scale;
      masks.push({ x: kp.clubhead.x * scale, y: kp.clubhead.y * scale, r2: r * r });
    }

    // Where to look. With a velocity in hand the ball is very nearly where
    // constant motion says; without one, the whole frame ahead of the ball is
    // fair game, narrowed by the direction it must have left in.
    const predicted = vel ? { x: prev.x + vel.x, y: prev.y + vel.y } : prev;
    const reach = vel ? Math.max(0.5 * Math.hypot(vel.x, vel.y), 0.08 * bodyPx) : 1.2 * bodyPx;

    const hit = scanBall(
      f.grey, frames[shot[j - 1]].grey,
      j + 1 < shot.length ? frames[shot[j + 1]].grey : null,
      { predicted, reach, from: prev, dir, freeSearch: !vel, masks, scale }
    );
    if (!hit) { out.lost = j - start; break; }

    f.keypoints.ball = { x: hit.x, y: hit.y, z: 0, score: 0.8, flight: true };
    out.points.push({ x: hit.x, y: hit.y, timeMs: f.timeMs });
    vel = { x: hit.x - prev.x, y: hit.y - prev.y };
    prev = { x: hit.x, y: hit.y };
  }

  out.quality = out.points.length >= MIN_TRACER_POINTS ? 'ok'
    : out.points.length ? 'weak' : 'none';
  return out;
}

// Landmarks to mask out during flight tracking, and how wide, as a fraction of
// the player's pixel height. Wider around the torso and arms, which are still
// swinging hard just after impact.
const LANDMARK_MASK_RADIUS = {
  nose: 0.10, left_shoulder: 0.12, right_shoulder: 0.12,
  left_elbow: 0.10, right_elbow: 0.10, left_wrist: 0.10, right_wrist: 0.10,
  left_hip: 0.12, right_hip: 0.12, left_knee: 0.10, right_knee: 0.10,
};

function scanBall(grey, prev, next, opts) {
  const { data, w, h } = grey;
  const pd = prev.data;
  const nd = next ? next.data : null;
  const { predicted, reach, from, dir, freeSearch, masks, scale } = opts;

  const px = predicted.x * scale, py = predicted.y * scale;
  const fx = from.x * scale, fy = from.y * scale;
  const rad = reach * scale;
  const invR2 = 1 / (2 * rad * rad);

  let bestW = 0, bestX = 0, bestY = 0, total = 0;
  const weights = new Float32Array(w * h);
  const x0 = Math.max(1, Math.floor(px - rad)), x1 = Math.min(w - 2, Math.ceil(px + rad));
  const y0 = Math.max(1, Math.floor(py - rad)), y1 = Math.min(h - 2, Math.ceil(py + rad));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const motion = nd
        ? Math.min(Math.abs(data[i] - pd[i]), Math.abs(data[i] - nd[i]))
        : Math.abs(data[i] - pd[i]);
      if (motion < MOTION_FLOOR) continue;

      let masked = false;
      for (const m of masks) {
        if ((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y) < m.r2) { masked = true; break; }
      }
      if (masked) continue;

      // On the first step there is no velocity yet, so the only thing keeping
      // this honest is where a struck ball is allowed to go: off toward the
      // target, and not downward into the ground.
      if (freeSearch) {
        const dx = x - fx, dy = y - fy;
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        if ((dx * dir) / len < -0.2) continue;   // must be broadly toward the target
        if (dy / len > 0.3) continue;            // and not diving into the turf
      }

      const dpx = x - px, dpy = y - py;
      const wgt = motion * Math.exp(-(dpx * dpx + dpy * dpy) * invR2);
      weights[i] = wgt;
      total += wgt;
      if (wgt > bestW) { bestW = wgt; bestX = x; bestY = y; }
    }
  }
  if (!bestW || !total) return null;

  // A ball is a small compact blob; the window stays tight so a big smear of
  // background motion cannot pass for one.
  const win = 3;
  let sw = 0, sx = 0, sy = 0;
  for (let y = Math.max(0, bestY - win); y <= Math.min(h - 1, bestY + win); y++) {
    for (let x = Math.max(0, bestX - win); x <= Math.min(w - 1, bestX + win); x++) {
      const wg = weights[y * w + x];
      if (!wg) continue;
      sw += wg; sx += wg * x; sy += wg * y;
    }
  }
  if (!sw || sw / total < 0.10) return null;
  return { x: (sx / sw) / scale, y: (sy / sw) / scale };
}

// The ball is only ever located once, at address — but it sits there until the
// club arrives, so every frame up to impact should carry it. Without this the
// marker blinks out during playback and the low-point fault has nothing to
// circle at the exact moment it is talking about.
export function placeBall(frames, ball) {
  if (!ball) return frames;
  for (const f of frames) {
    f.keypoints.ball = { ...ball };
    if (f.phase === 'impact') break; // after this the ball is gone, honestly
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Arc geometry
// ---------------------------------------------------------------------------

// Least-squares circle through 3+ points (Kåsa). Returns null when the points
// are collinear, which is the honest answer for a bad track.
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const det = 2 * (suu * svv - suv * suv);
  if (Math.abs(det) < 1e-6) return null;
  const uc = (svv * (suuu + suvv) - suv * (svvv + svuu)) / det;
  const vc = (suu * (svvv + svuu) - suv * (suuu + suvv)) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!isFinite(r) || r <= 0) return null;
  return { cx: uc + mx, cy: vc + my, r };
}

// Direction of travel along the circle at a point, oriented down the target
// line. The tangent is the radius turned 90°.
function tangentAt(circle, pt, dir) {
  const rx = pt.x - circle.cx, ry = pt.y - circle.cy;
  let tx = -ry, ty = rx;
  if (tx * dir < 0) { tx = -tx; ty = -ty; }
  const m = Math.hypot(tx, ty) || 1;
  return { x: tx / m, y: ty / m };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
  if (!m1 || !m2) return null;
  const cos = clamp((v1.x * v2.x + v1.y * v2.y) / (m1 * m2), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

// When the club actually started back — the last frame before the hands leave
// address. Tempo measured from frame 0 would count however long the player
// waddled about before starting.
function takeawayIndex(frames, topIdx, lead) {
  const first = frames.find((f) => P(f.keypoints, `${lead}_wrist`));
  if (!first) return 0;
  const base = P(first.keypoints, `${lead}_wrist`);
  const ls = P(first.keypoints, 'left_shoulder'), rs = P(first.keypoints, 'right_shoulder');
  const sw = ls && rs ? Math.hypot(ls.x - rs.x, ls.y - rs.y) : null;
  if (!sw) return 0;
  for (let i = 0; i < topIdx; i++) {
    const w = P(frames[i].keypoints, `${lead}_wrist`);
    if (w && Math.hypot(w.x - base.x, w.y - base.y) > sw * 0.15) return Math.max(0, i - 1);
  }
  return 0;
}

// Everything the club track can tell us, or nulls where it can't.
export function clubMetrics(frames, ideal, track = {}) {
  const profile = ideal.profile;
  const lead = profile.handedness === 'right' ? 'left' : 'right';
  const pxPerCm = track.pxPerCm || estimatePxPerCm(frames, profile);
  const out = {
    tempoRatio: null, backswingMs: null, downswingMs: null,
    speedMph: null, attackAngle: null, lowPointCm: null, lagAngle: null,
    ball: null, ballDetected: false, slowMo: false, arc: null,
    launchAngle: null, flightPoints: 0, tracerQuality: 'none',
    tracked: track.tracked || 0, quality: 'none',
  };

  const topIdx = frames.findIndex((f) => f.phase === 'top');
  const impactIdx = frames.findIndex((f) => f.phase === 'impact');
  const impact = frames[impactIdx];

  // ---- tempo: pure timing, so it survives even when the club is invisible
  if (topIdx > 0 && impactIdx > topIdx) {
    const startIdx = takeawayIndex(frames, topIdx, lead);
    const back = frames[topIdx].timeMs - frames[startIdx].timeMs;
    const down = frames[impactIdx].timeMs - frames[topIdx].timeMs;
    if (back > 0 && down > 0) {
      out.backswingMs = back;
      out.downswingMs = down;
      out.tempoRatio = Math.round((back / down) * 10) / 10;
      out.slowMo = back + down > SLOWMO_MS;
    }
  }

  const dir = impact ? targetDirection(impact.keypoints, profile.handedness) : 1;
  out.ball = frames[0]?.keypoints?.ball || null;
  out.ballDetected = !!(out.ball && !out.ball.estimated);

  // ---- the arc: every club number below is read off this one fit
  const arcPts = [];
  for (let i = 0; i < frames.length; i++) {
    const c = frames[i].keypoints.clubhead;
    if (!c || c.score < 0.3) continue;
    const ph = frames[i].phase;
    // Downswing through early follow-through only — the backswing is a
    // different (and much slower) arc, and mixing them ruins the fit.
    if (ph !== 'downswing' && ph !== 'impact' && ph !== 'follow-through') continue;
    if (impactIdx >= 0 && i > impactIdx + 3) continue;
    arcPts.push({ x: c.x, y: c.y, t: frames[i].timeMs, i });
  }

  const circle = arcPts.length >= 3 ? fitCircle(arcPts) : null;
  const impactPt = impact?.keypoints?.clubhead;
  // Sanity: the arc has to look like a golf swing — a radius in the right
  // ballpark, centred above the clubhead. A fit that fails this is noise.
  const plausible = circle && impactPt && pxPerCm
    && circle.r > 0.4 * (track.radiusPx || circle.r)
    && circle.r < 2.5 * (track.radiusPx || circle.r)
    && circle.cy < impactPt.y;

  if (plausible) {
    out.arc = circle;
    const tan = tangentAt(circle, impactPt, dir);
    // Screen y grows downward, so a negative y-component is travelling up.
    out.attackAngle = Math.round((Math.atan2(-tan.y, Math.abs(tan.x)) * 180) / Math.PI * 10) / 10;

    // The bottom of a circle sits directly below its centre, so the low point
    // of the swing arc is simply cx — no need to catch it on a frame.
    const ballPt = out.ball;
    if (ballPt && pxPerCm) {
      out.lowPointCm = Math.round(((circle.cx - ballPt.x) * dir / pxPerCm) * 10) / 10;
    }

    // Speed as radius × angular velocity: the arc the clubhead really travels,
    // not the straight line between two widely spaced samples.
    if (pxPerCm && !out.slowMo) {
      let bestOmega = 0;
      for (let k = 1; k < arcPts.length; k++) {
        const a = arcPts[k - 1], b = arcPts[k];
        const dt = (b.t - a.t) / 1000;
        if (dt <= 0) continue;
        const th0 = Math.atan2(a.y - circle.cy, a.x - circle.cx);
        const th1 = Math.atan2(b.y - circle.cy, b.x - circle.cx);
        let dth = th1 - th0;
        while (dth > Math.PI) dth -= 2 * Math.PI;
        while (dth < -Math.PI) dth += 2 * Math.PI;
        bestOmega = Math.max(bestOmega, Math.abs(dth) / dt);
      }
      if (bestOmega > 0) {
        const cmPerS = (circle.r / pxPerCm) * bestOmega;
        out.speedMph = Math.round(cmPerS * CM_S_TO_MPH);
      }
    }
  }

  // ---- lag: forearm-to-shaft angle halfway down, the casting tell
  if (topIdx >= 0 && impactIdx > topIdx) {
    const midMs = (frames[topIdx].timeMs + frames[impactIdx].timeMs) / 2;
    let mid = null, bestD = Infinity;
    for (let i = topIdx; i <= impactIdx; i++) {
      const c = frames[i].keypoints.clubhead;
      if (!c || c.score < 0.3) continue;
      const d = Math.abs(frames[i].timeMs - midMs);
      if (d < bestD) { bestD = d; mid = frames[i]; }
    }
    if (mid) {
      const kp = mid.keypoints;
      out.lagAngle = Math.round(
        angleAt(P(kp, `${lead}_elbow`), P(kp, `${lead}_wrist`), kp.clubhead) ?? NaN
      );
      if (!isFinite(out.lagAngle)) out.lagAngle = null;
      out.lagFrameMs = mid.timeMs;
    }
  }

  // ---- launch: the direction the ball actually left in
  const flight = frames
    .filter((f) => f.keypoints.ball && f.keypoints.ball.flight)
    .map((f) => ({ x: f.keypoints.ball.x, y: f.keypoints.ball.y, timeMs: f.timeMs }));
  out.flightPoints = flight.length;
  out.tracerQuality = flight.length >= MIN_TRACER_POINTS ? 'ok' : flight.length ? 'weak' : 'none';

  const struckFrom = impact?.keypoints?.ball && !impact.keypoints.ball.flight
    ? impact.keypoints.ball
    : out.ball;
  if (struckFrom && flight.length >= MIN_TRACER_POINTS) {
    // Straight line from the ball to the last point still close to impact.
    // Over the few milliseconds a tracer covers, gravity has not bent the
    // flight enough to matter, and a line averages out the per-point jitter
    // that fitting a curve to three points would amplify.
    const end = flight[Math.min(flight.length, 3) - 1];
    const dx = end.x - struckFrom.x;
    const dy = end.y - struckFrom.y;
    if (Math.hypot(dx, dy) > 1) {
      out.launchAngle = Math.round((Math.atan2(-dy, Math.abs(dx)) * 180) / Math.PI * 10) / 10;
    }
  }

  const arcCount = arcPts.length;
  out.quality = plausible && arcCount >= 4 ? 'ok'
    : out.tracked > 0 ? 'weak'
    : 'none';
  return out;
}

// ---------------------------------------------------------------------------
// Targets and faults
// ---------------------------------------------------------------------------

// Club-specific targets. Kept here rather than in buildIdealModel so the
// engine stays a verbatim port of the native one.
export function clubTargets(profile, sensitivity = 'normal') {
  const club = profile.club || 'iron';
  const base = {
    // A teed driver is struck on the way up; irons and wedges on the way down.
    attackAngle: club === 'driver' ? [0, 7] : club === 'wedge' ? [-9, -2] : [-6, -1],
    // Tour tempo is famously close to 3:1 backswing to downswing.
    tempo: [2.2, 3.8],
    // Forearm-to-shaft angle halfway down. Wide open here is a cast.
    lagMax: 120,
    // How far past the ball the arc should bottom out, in cm. Meaningless off
    // a tee, so the driver opts out.
    lowPointMinCm: club === 'driver' ? null : 1,
    // Where a well-struck shot should leave. Reported for information only —
    // no fault hangs off it, because on anything but a slow-mo clip the tracer
    // has too few points to carry a number that could cost somebody score.
    launchAngle: club === 'driver' ? [10, 16] : club === 'wedge' ? [26, 36] : [14, 22],
  };
  if (sensitivity === 'relaxed') {
    base.attackAngle = [base.attackAngle[0] - 3, base.attackAngle[1] + 3];
    base.tempo = [base.tempo[0] - 0.5, base.tempo[1] + 0.7];
    base.lagMax += 12;
    if (base.lowPointMinCm != null) base.lowPointMinCm -= 3;
  } else if (sensitivity === 'strict') {
    base.attackAngle = [base.attackAngle[0] + 1, base.attackAngle[1] - 1];
    base.tempo = [base.tempo[0] + 0.3, base.tempo[1] - 0.4];
    base.lagMax -= 10;
    if (base.lowPointMinCm != null) base.lowPointMinCm += 2;
  }
  return base;
}

const CM_PER_IN = 2.54;

// Faults the club track can see that the body alone cannot. Each carries the
// same shape as an engine fault, so the overlay and the drill/plan/score code
// need no special case — `clubhead` and `ball` resolve as ordinary points.
export function clubFaults(metrics, targets, profile) {
  const lead = profile.handedness === 'right' ? 'left' : 'right';
  const faults = [];
  const shaft = [[`${lead}_wrist`, 'clubhead']];

  if (metrics.tempoRatio != null) {
    const [lo, hi] = targets.tempo;
    if (metrics.tempoRatio < lo) {
      faults.push({
        at: 'top', id: 'rushed-transition',
        label: `Transition rushed (${metrics.tempoRatio.toFixed(1)}:1 tempo, ideal ${lo.toFixed(1)}–${hi.toFixed(1)}:1)`,
        tip: 'You are spending the swing\'s energy before the club has finished going back. Let the club arrive at the top, then start down from the ground.',
        edges: shaft, circleAround: [`${lead}_wrist`], severity: 'minor',
      });
    } else if (metrics.tempoRatio > hi) {
      faults.push({
        at: 'top', id: 'lazy-transition',
        label: `Downswing dawdles (${metrics.tempoRatio.toFixed(1)}:1 tempo, ideal ${lo.toFixed(1)}–${hi.toFixed(1)}:1)`,
        tip: 'Plenty of backswing, no urgency down. Same backswing, then accelerate — the club should be fastest at the ball, not before it.',
        edges: shaft, circleAround: [`${lead}_wrist`], severity: 'minor',
      });
    }
  }

  if (metrics.lagAngle != null && metrics.lagAngle > targets.lagMax) {
    faults.push({
      at: 'downswing', id: 'casting',
      label: `Casting the club (${metrics.lagAngle}° wrist angle halfway down, ideal ≤ ${targets.lagMax}°)`,
      tip: 'Your wrists are unhinging at the top of the downswing, so all the speed is spent above the ball. Keep the angle and let it release itself.',
      edges: [[`${lead}_elbow`, `${lead}_wrist`], ...shaft],
      circleAround: [`${lead}_wrist`], severity: 'major',
    });
  }

  if (metrics.attackAngle != null) {
    const [lo, hi] = targets.attackAngle;
    if (metrics.attackAngle < lo) {
      const driver = profile.club === 'driver';
      faults.push({
        at: 'impact', id: driver ? 'driver-hitting-down' : 'too-steep',
        label: `${driver ? 'Hitting down on the driver' : 'Steep into the ball'} (${metrics.attackAngle.toFixed(1)}° attack, ideal ${lo}–${hi}°)`,
        tip: driver
          ? 'Tee it higher, play the ball off your lead heel, and feel the club sweeping up off the tee — that is where cheap distance lives.'
          : 'The club is arriving too steeply. Shallow it out by turning your body through rather than throwing the arms down at the ball.',
        edges: shaft, circleAround: ['clubhead'], severity: 'minor',
      });
    } else if (metrics.attackAngle > hi) {
      faults.push({
        at: 'impact', id: 'scooping',
        label: `Scooping at impact (${metrics.attackAngle.toFixed(1)}° attack, ideal ${lo}–${hi}°)`,
        tip: 'You are trying to help the ball into the air. The loft already does that — hit down and let the ball come up off the face.',
        edges: shaft, circleAround: ['clubhead', 'ball'], severity: 'major',
      });
    }
  }

  if (targets.lowPointMinCm != null && metrics.lowPointCm != null
      && metrics.lowPointCm < targets.lowPointMinCm) {
    const behind = Math.abs(metrics.lowPointCm) / CM_PER_IN;
    faults.push({
      at: 'impact', id: 'low-point-behind-ball',
      label: `Swing bottoms out ${behind.toFixed(1)}" behind the ball`,
      tip: 'That is the fat/thin pattern: the club is already climbing when it reaches the ball. Get your weight to the lead side going down so the low point moves in front of it.',
      edges: [['clubhead', 'ball']], circleAround: ['clubhead', 'ball'], severity: 'major',
    });
  }
  return faults;
}

// Attach club faults to the right frames. Only fires when the arc fit actually
// held up — a guessed number must never cost somebody score.
export function applyClubFaults(frames, metrics, targets, profile) {
  if (metrics.quality !== 'ok') {
    // Tempo is timing-only, so it stands even when the clubhead was never
    // found. Everything else needs the arc.
    const timing = clubFaults(metrics, targets, profile).filter((f) => f.id.endsWith('-transition'));
    if (!timing.length) return frames;
    return attach(frames, timing);
  }
  return attach(frames, clubFaults(metrics, targets, profile));
}

function attach(frames, faults) {
  return frames.map((f) => {
    const mine = faults.filter((x) => x.at === f.phase);
    if (!mine.length) return f;
    return { ...f, faults: [...f.faults, ...mine.map(({ at, ...rest }) => rest)] };
  });
}

// ---------------------------------------------------------------------------
// Checkpoint rows (same shape measureCheckpoints returns, so the table just works)
// ---------------------------------------------------------------------------

export function clubCheckpointRows(metrics, targets, units = 'imperial') {
  const rows = [];
  if (metrics.tempoRatio != null) {
    rows.push({
      label: 'Tempo (back : down)', measured: metrics.tempoRatio,
      target: targets.tempo, kind: 'range', unit: ':1',
    });
  }
  if (metrics.speedMph != null) {
    rows.push({
      label: 'Clubhead speed (est.)', measured: metrics.speedMph,
      target: null, kind: 'info', unit: ' mph',
    });
  }
  if (metrics.attackAngle != null) {
    rows.push({
      label: 'Attack angle', measured: metrics.attackAngle,
      target: targets.attackAngle, kind: 'range', unit: '°',
    });
  }
  if (metrics.lagAngle != null) {
    rows.push({
      label: 'Wrist lag halfway down', measured: metrics.lagAngle,
      target: targets.lagMax, kind: 'max', unit: '°',
    });
  }
  if (metrics.launchAngle != null) {
    rows.push({
      label: 'Launch angle', measured: metrics.launchAngle,
      target: targets.launchAngle, kind: 'range', unit: '°',
    });
  }
  if (metrics.lowPointCm != null && targets.lowPointMinCm != null) {
    const imperial = units !== 'metric';
    rows.push({
      label: 'Low point vs ball', unit: imperial ? '"' : ' cm',
      measured: imperial
        ? Math.round((metrics.lowPointCm / CM_PER_IN) * 10) / 10
        : metrics.lowPointCm,
      target: imperial
        ? Math.round((targets.lowPointMinCm / CM_PER_IN) * 10) / 10
        : targets.lowPointMinCm,
      kind: 'min',
    });
  }
  for (const r of rows) {
    if (r.measured == null || r.kind === 'info') { r.ok = null; continue; }
    if (r.kind === 'range') r.ok = r.measured >= r.target[0] && r.measured <= r.target[1];
    else if (r.kind === 'min') r.ok = r.measured >= r.target;
    else r.ok = r.measured <= r.target;
  }
  return rows;
}
