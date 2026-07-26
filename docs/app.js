// Swing Coach Pro — web app.
//
// Flow: build the personal model from the profile → upload a swing video →
// MediaPipe detects a pose track → the app's real engine labels phases and
// scores faults → the video plays back with the faulty body parts drawn in
// red/amber at the moment they happen. Around that core: a checkpoint table
// (you vs your model), a 0–100 swing score, slow-mo coaching playback, a
// printable practice plan, on-device progress history, and a shareable
// summary card.

import {
  buildIdealModel, describeModel, DEFAULT_PROFILE,
  labelPhases, analyzeFrames, resolvePoint, measureCheckpoints, EDGES, MIN_SCORE,
} from './engine.js';
import { detectSwing, detectLiveFrame } from './pose.js';
import { drillFor } from './drills.js';
import { buildDemoSwing } from './demo.js';
import {
  trackClubhead, trackBallFlight, findBall, placeBall, clubMetrics, clubTargets,
  applyClubFaults, clubCheckpointRows,
} from './clubTrack.js';

const FLAG = '#e4353b', AMBER = '#e8a33d', CHALK = '#f2efe6', GOOD = '#8fd6a5';
const TRACER = '#ffd76a'; // shot tracer — reads against both sky and turf
const KEY_PHASES = ['setup', 'top', 'impact'];
const HISTORY_KEY = 'scp-history';
const FRAME_STEP = 1 / 30;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const state = {
  profile: { ...DEFAULT_PROFILE },
  sensitivity: 'normal',
  units: 'imperial', // display only — profile stays metric, the engine's units
  ideal: null,
  results: null,
  club: null,        // clubhead/ball metrics for the current swing
  clubTrack: null,   // scale + hit count from the pixel tracker
  showClubPath: true,
  showTracer: true,
  isSample: false,
  videoObjectUrl: null,
};

// The engine thinks in cm/kg; the form shows ft-in/lb/in unless metric.
const CM_PER_IN = 2.54;
const LB_PER_KG = 2.2046226218;

function cmToFtIn(cm) {
  const totalIn = cm / CM_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return { ft, inch };
}
const fmtHeight = (cm) => {
  if (state.units === 'metric') return `${Math.round(cm)} cm`;
  const { ft, inch } = cmToFtIn(cm);
  return `${ft}'${inch}"`;
};
const fmtWeight = (kg) =>
  state.units === 'metric' ? `${Math.round(kg)} kg` : `${Math.round(kg * LB_PER_KG)} lb`;

function fillUnitFields() {
  const p = state.profile;
  const imperial = state.units === 'imperial';
  if (imperial) {
    const { ft, inch } = cmToFtIn(p.heightCm);
    $('heightFt').value = String(ft);
    $('heightIn').value = String(inch);
    $('weight').value = String(Math.round(p.weightKg * LB_PER_KG));
    $('wingspan').value = String(Math.round(p.wingspanCm / CM_PER_IN));
  } else {
    $('heightCm').value = String(Math.round(p.heightCm));
    $('weight').value = String(Math.round(p.weightKg));
    $('wingspan').value = String(Math.round(p.wingspanCm));
  }
  $('height-imperial').hidden = !imperial;
  $('heightCm').hidden = imperial;
  $('weight-label').textContent = imperial ? 'Weight (lb)' : 'Weight (kg)';
  $('wingspan-label').textContent = imperial ? 'Wingspan (in)' : 'Wingspan (cm)';
}

function readUnitFields() {
  const n = (id) => Number($(id).value) || 0;
  if (state.units === 'imperial') {
    state.profile.heightCm = (n('heightFt') * 12 + n('heightIn')) * CM_PER_IN;
    state.profile.weightKg = n('weight') / LB_PER_KG;
    state.profile.wingspanCm = n('wingspan') * CM_PER_IN;
  } else {
    state.profile.heightCm = n('heightCm');
    state.profile.weightKg = n('weight');
    state.profile.wingspanCm = n('wingspan');
  }
  state.profile.age = n('age');
}

// ---------- strictness ----------
// Widens (relaxed) or narrows (strict) the personal model's acceptance bands.
// Applied on top of buildIdealModel so the engine port stays verbatim.
function applySensitivity(ideal, mode) {
  if (mode === 'normal') return ideal;
  const m = structuredClone(ideal);
  const relax = mode === 'relaxed';
  const adj = (r, d) => (relax ? [r[0] - d, r[1] + d] : [r[0] + d, r[1] - d]);
  const mod = m.model;
  mod.spineTiltAtAddress = adj(mod.spineTiltAtAddress, 4);
  mod.kneeFlexAtAddress = adj(mod.kneeFlexAtAddress, 4);
  mod.spineTiltAtImpact = adj(mod.spineTiltAtImpact, 4);
  mod.trailElbowTop = adj(mod.trailElbowTop, 10);
  if (relax) {
    mod.leadArmStraightTop = [mod.leadArmStraightTop[0] - 10, mod.leadArmStraightTop[1]];
    mod.headSwayMaxPctShoulderWidth += 12;
    mod.hipOpenAtImpact = [mod.hipOpenAtImpact[0] - 8, mod.hipOpenAtImpact[1] + 3];
    mod.leadLegImpact = [mod.leadLegImpact[0] - 8, mod.leadLegImpact[1]];
  } else {
    mod.leadArmStraightTop = [mod.leadArmStraightTop[0] + 6, mod.leadArmStraightTop[1]];
    mod.headSwayMaxPctShoulderWidth = Math.max(10, mod.headSwayMaxPctShoulderWidth - 10);
    mod.hipOpenAtImpact = [mod.hipOpenAtImpact[0] + 5, mod.hipOpenAtImpact[1]];
    mod.leadLegImpact = [mod.leadLegImpact[0] + 5, mod.leadLegImpact[1]];
  }
  return m;
}

// ---------- profile + ideal model ----------
function renderModel() {
  state.ideal = applySensitivity(buildIdealModel(state.profile), state.sensitivity);
  $('model').innerHTML = describeModel(state.ideal)
    .map((l) => {
      const [k, ...rest] = l.split(': ');
      return `<div class="model-line">• ${esc(k)}: <b>${esc(rest.join(': '))}</b></div>`;
    })
    .join('');
  const p = state.ideal.profile;
  $('model-note').textContent =
    `Adjusted for ${fmtHeight(p.heightCm)}, ${fmtWeight(p.weightKg)} (BMI ${state.ideal.bmi}), ${p.flexibility} flexibility, ${p.club}.` +
    (state.sensitivity === 'normal' ? '' : ` Thresholds set to ${state.sensitivity}.`);
}

['heightFt', 'heightIn', 'heightCm', 'weight', 'wingspan', 'age'].forEach((id) => {
  $(id).addEventListener('input', () => {
    readUnitFields();
    renderModel();
    if (state.results) rescore();
  });
});

document.querySelectorAll('.seg').forEach((seg) => {
  const key = seg.dataset.key;
  seg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (key === 'sensitivity') state.sensitivity = btn.dataset.val;
      else if (key === 'units') state.units = btn.dataset.val;
      else state.profile[key] = btn.dataset.val;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (key === 'units') fillUnitFields();
      renderModel();
      if (state.results) rescore();
    });
  });
});

// One pipeline for every path into the results: analyze, demo and rescore all
// go through here, so club metrics can never fall out of step with the score.
function scoreFrames(rawFrames) {
  const labeled = labelPhases(rawFrames, state.ideal.profile.handedness);
  const analyzed = analyzeFrames(labeled, state.ideal);
  placeBall(analyzed, analyzed[0]?.keypoints?.ball);
  const targets = clubTargets(state.ideal.profile, state.sensitivity);
  const metrics = clubMetrics(analyzed, state.ideal, state.clubTrack || {});
  // The sample skeleton is schematic rather than anatomically scaled, so its
  // pixels-per-cm — and therefore any speed read off them — is meaningless.
  if (state.isSample) metrics.speedMph = null;
  state.club = metrics;
  return applyClubFaults(analyzed, metrics, targets, state.ideal.profile);
}

// Re-run scoring on an existing pose track when the profile or thresholds change.
function rescore() {
  if (!state.results) return;
  state.results = scoreFrames(state.results.map(stripFault));
  renderAll();
  drawCurrentFrame();
}
const stripFault = (f) => ({ timeMs: f.timeMs, width: f.width, height: f.height, keypoints: f.keypoints });

// ---------- video upload ----------
const video = $('video');

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (state.videoObjectUrl) URL.revokeObjectURL(state.videoObjectUrl);
  state.videoObjectUrl = URL.createObjectURL(file);
  state.results = null;
  renderAll();
  video.src = state.videoObjectUrl;
  video.load();
  setStatus('');
});

video.addEventListener('loadedmetadata', () => {
  $('stage').hidden = false;
  $('pb').hidden = false;
  $('analyze').disabled = false;
  $('analyze').textContent = 'Analyze my swing';
  sizeCanvas();
});
// Some browsers (notably Chrome) can't decode iPhone HEVC/.mov. Say so plainly
// instead of leaving Analyze dead with no explanation.
video.addEventListener('error', () => {
  $('analyze').disabled = true;
  $('analyze').textContent = 'Choose a video first';
  setStatus(
    "This video wouldn't play in your browser — iPhone .mov (HEVC) often won't decode in Chrome. " +
    'Try Safari, or on the iPhone use Share → Options → Most Compatible, or export to MP4 (H.264).',
    true
  );
});
video.addEventListener('timeupdate', drawCurrentFrame);
video.addEventListener('seeked', drawCurrentFrame);
// timeupdate only fires ~4×/s; run the overlay at frame rate while playing.
function tick() {
  drawCurrentFrame();
  if (!video.paused && !video.ended) requestAnimationFrame(tick);
}
video.addEventListener('play', () => requestAnimationFrame(tick));
window.addEventListener('resize', () => { sizeCanvas(); drawCurrentFrame(); });

// ---------- coaching playback controls ----------
document.querySelectorAll('[data-rate]').forEach((btn) => {
  btn.addEventListener('click', () => {
    video.playbackRate = Number(btn.dataset.rate);
    document.querySelectorAll('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});
$('step-back').addEventListener('click', () => stepFrame(-1));
$('step-fwd').addEventListener('click', () => stepFrame(1));
$('toggle-club').addEventListener('click', () => {
  state.showClubPath = !state.showClubPath;
  $('toggle-club').setAttribute('aria-pressed', String(state.showClubPath));
  drawCurrentFrame();
});
$('toggle-tracer').addEventListener('click', () => {
  state.showTracer = !state.showTracer;
  $('toggle-tracer').setAttribute('aria-pressed', String(state.showTracer));
  drawCurrentFrame();
});
function stepFrame(dir) {
  if (!video.duration) return;
  video.pause();
  video.currentTime = Math.min(Math.max(video.currentTime + dir * FRAME_STEP, 0), video.duration - 0.01);
}

function renderPhaseChips() {
  const el = $('pb-phases');
  if (!state.results || !video.src) { el.innerHTML = ''; return; }
  el.innerHTML = KEY_PHASES.map((ph) => {
    const f = state.results.find((r) => r.phase === ph);
    return f ? `<button data-seek="${f.timeMs}">${esc(ph)} ${(f.timeMs / 1000).toFixed(2)}s</button>` : '';
  }).join('');
  el.querySelectorAll('[data-seek]').forEach((btn) => {
    btn.addEventListener('click', () => {
      video.pause();
      video.currentTime = Number(btn.dataset.seek) / 1000;
    });
  });
}

// ---------- analyze ----------
$('analyze').addEventListener('click', async () => {
  if (!video.src) return;
  const btn = $('analyze');
  btn.disabled = true;
  setStatus('Warming up…');
  try {
    video.pause();
    const frames = await detectSwing(video, { fps: 30, maxFrames: 90, grey: true }, (i, n) => {
      if (typeof n === 'number') setStatus(`Detecting your body — frame ${i}/${n}…`);
      else setStatus(i);
    });
    if (frames.length < 4) {
      throw new Error('Could not find a full body. Film face-on with your whole body in frame, in good light.');
    }
    setStatus('Following the clubhead…');
    await trackClub(frames);
    state.isSample = false;
    state.results = scoreFrames(frames);
    setStatus('');
    recordHistory();
    renderAll();
    renderPhaseChips();
    video.currentTime = 0;
    drawCurrentFrame();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
});

// Seek and wait for the picture to actually be there, so the ball search reads
// the address frame rather than whatever was on screen a moment ago.
function seekTo(seconds) {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', done, { once: true });
    video.currentTime = seconds;
  });
}

// Find the ball at address, follow the clubhead through the swing, then throw
// the greyscale buffers away — 90 frames of them is real memory and they have
// no use once the track exists.
async function trackClub(frames) {
  state.club = null;
  state.clubTrack = null;
  try {
    await seekTo(Math.max(0, frames[0].timeMs / 1000));
    const ball = findBall(video, frames[0], state.ideal);
    if (ball) frames[0].keypoints.ball = ball;
    state.clubTrack = trackClubhead(frames, state.ideal, ball);
    // The tracer needs to know which frame is impact, and phase labelling is a
    // pure function of the pose track — so run it here rather than threading
    // the index back out of scoreFrames later. It gets computed identically
    // there; this is cheap and keeps the greyscale buffers in one place.
    const impactIdx = labelPhases(frames, state.ideal.profile.handedness)
      .findIndex((f) => f.phase === 'impact');
    trackBallFlight(frames, state.ideal, ball, impactIdx);
  } catch {
    // Tracking is a bonus on top of the body analysis — never let it take the
    // whole result down with it.
  } finally {
    for (const f of frames) delete f.grey;
  }
}

$('demo').addEventListener('click', () => {
  state.isSample = true;
  state.clubTrack = null;
  state.results = scoreFrames(buildDemoSwing());
  recordHistory();
  renderAll();
  renderPhaseChips();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

// ---------- overlay ----------
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

function sizeCanvas() {
  const rect = video.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function nearestFrame() {
  if (!state.results || !state.results.length) return null;
  const nowMs = video.currentTime * 1000;
  let best = state.results[0], bestD = Infinity;
  for (const f of state.results) {
    const d = Math.abs(f.timeMs - nowMs);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

function drawCurrentFrame() {
  if (!video.videoWidth) return;
  const rect = video.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const frame = nearestFrame();
  if (!frame) return;
  const scale = rect.width / video.videoWidth;
  if (state.showClubPath) drawClubPath(ctx, frame, scale);
  if (state.showTracer) drawTracer(ctx, frame, scale);
  drawSkeleton(ctx, frame, scale);
  renderActiveBanner(frame);
}

// The shot tracer: the ball's flight off the face, drawn as it happens.
//
// It stops where the tracking stopped, plus a short extrapolation that fades
// out. Real broadcast tracers follow the ball to the ground; this one has a
// handful of frames of a departing ball and no idea where it lands, so it
// shows the line it actually measured and lets it dissolve rather than
// inventing a landing spot.
function drawTracer(g, frame, scale) {
  if (!state.results) return;
  const flight = state.results
    .filter((f) => f.keypoints.ball && f.keypoints.ball.flight && f.timeMs <= frame.timeMs)
    .map((f) => f.keypoints.ball);
  if (!flight.length) return;

  // Anchor the line on the ball where it was struck, not on the first frame
  // the tracker managed to catch it.
  const impact = state.results.find((f) => f.phase === 'impact');
  const struck = impact?.keypoints?.ball;
  const pts = struck && !struck.flight ? [struck, ...flight] : flight;
  if (pts.length < 2) return;

  const X = (v) => v * scale, Y = (v) => v * scale;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 6;
  g.strokeStyle = TRACER;
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(X(pts[0].x), Y(pts[0].y));
  for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i].x), Y(pts[i].y));
  g.stroke();

  // Carry the last measured direction on a little way, fading, so the eye
  // reads "still going" instead of "stopped dead in mid-air".
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    g.globalAlpha = 0.5 * (1 - i / steps);
    g.beginPath();
    g.moveTo(X(b.x + dx * i * 0.4), Y(b.y + dy * i * 0.4));
    g.lineTo(X(b.x + dx * (i + 1) * 0.4), Y(b.y + dy * (i + 1) * 0.4));
    g.stroke();
  }
  g.globalAlpha = 1;

  // The ball itself, at the head of the line.
  g.fillStyle = TRACER;
  g.beginPath(); g.arc(X(b.x), Y(b.y), 5, 0, Math.PI * 2); g.fill();
  g.restore();
}

// The clubhead's route through the swing, drawn up to wherever playback is.
// Older positions fade out, so at any instant you can see the arc the club has
// travelled and where it is heading — the shape of the swing, not just a dot.
function drawClubPath(g, frame, scale) {
  if (!state.results) return;
  const pts = state.results
    .filter((f) => f.timeMs <= frame.timeMs && f.keypoints.clubhead)
    .map((f) => f.keypoints.clubhead);
  if (pts.length < 2) return;
  const X = (v) => v * scale, Y = (v) => v * scale;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    // Fade with age: the newest segment is fully lit, the takeaway is a ghost.
    g.globalAlpha = 0.18 + 0.62 * (i / (pts.length - 1));
    g.strokeStyle = GOOD;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(X(pts[i - 1].x), Y(pts[i - 1].y));
    g.lineTo(X(pts[i].x), Y(pts[i].y));
    g.stroke();
  }
  g.globalAlpha = 1;
}

// Canvas port of FrameOverlay.js: chalk skeleton, faulty edges in red/amber,
// dashed circles around the section to change.
function drawSkeleton(g, frame, scale) {
  const kp = frame.keypoints;
  const faultEdges = new Map();
  const extraEdges = [];
  const circles = [];
  for (const fault of frame.faults) {
    const color = fault.severity === 'major' ? FLAG : AMBER;
    for (const [a, b] of fault.edges) {
      const key = [a, b].slice().sort().join('|');
      if (EDGES.some(([x, y]) => [x, y].slice().sort().join('|') === key)) faultEdges.set(key, color);
      else extraEdges.push({ a, b, color });
    }
    const pts = fault.circleAround.map((n) => resolvePoint(kp, n)).filter((p) => p && p.score >= MIN_SCORE);
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const r = Math.max(24 / scale, ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy) + 18 / scale));
      circles.push({ cx, cy, r, color });
    }
  }
  const X = (v) => v * scale, Y = (v) => v * scale;

  g.lineCap = 'round';
  for (const [a, b] of EDGES) {
    const pa = kp[a], pb = kp[b];
    if (!pa || !pb || pa.score < MIN_SCORE || pb.score < MIN_SCORE) continue;
    const key = [a, b].slice().sort().join('|');
    const col = faultEdges.get(key);
    g.strokeStyle = col || CHALK;
    g.globalAlpha = col ? 1 : 0.85;
    g.lineWidth = col ? 6 : 3;
    g.beginPath(); g.moveTo(X(pa.x), Y(pa.y)); g.lineTo(X(pb.x), Y(pb.y)); g.stroke();
  }
  g.globalAlpha = 1;
  for (const e of extraEdges) {
    const pa = resolvePoint(kp, e.a), pb = resolvePoint(kp, e.b);
    if (!pa || !pb) continue;
    g.strokeStyle = e.color; g.lineWidth = 6;
    g.beginPath(); g.moveTo(X(pa.x), Y(pa.y)); g.lineTo(X(pb.x), Y(pb.y)); g.stroke();
  }
  for (const name in kp) {
    // The club and the ball are not body joints — they get their own marks below.
    if (name === 'clubhead' || name === 'ball') continue;
    if (kp[name].score < MIN_SCORE) continue;
    g.fillStyle = CHALK;
    g.beginPath(); g.arc(X(kp[name].x), Y(kp[name].y), 4, 0, Math.PI * 2); g.fill();
  }
  drawClub(g, kp, X, Y);
  g.setLineDash([14 * scale, 8 * scale]);
  for (const c of circles) {
    g.strokeStyle = c.color; g.lineWidth = 4;
    g.beginPath(); g.arc(X(c.cx), Y(c.cy), c.r * scale, 0, Math.PI * 2); g.stroke();
  }
  g.setLineDash([]);
}

// The shaft (hands to clubhead), the clubhead itself, and the ball. Drawn on
// top of the skeleton so the club reads as one object with the body.
function drawClub(g, kp, X, Y) {
  const club = kp.clubhead;
  // A ball in flight belongs to the tracer, which draws its own head marker.
  const ball = kp.ball && !kp.ball.flight ? kp.ball : null;
  if (ball) {
    g.strokeStyle = CHALK;
    g.lineWidth = 2;
    g.globalAlpha = ball.estimated ? 0.5 : 1; // a guessed ball says so, faintly
    g.beginPath(); g.arc(X(ball.x), Y(ball.y), 6, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
  }
  if (!club) return;
  const hands = kp.left_wrist && kp.right_wrist
    ? { x: (kp.left_wrist.x + kp.right_wrist.x) / 2, y: (kp.left_wrist.y + kp.right_wrist.y) / 2 }
    : kp.left_wrist || kp.right_wrist;
  if (hands) {
    g.strokeStyle = CHALK;
    g.globalAlpha = 0.9;
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(X(hands.x), Y(hands.y)); g.lineTo(X(club.x), Y(club.y)); g.stroke();
    g.globalAlpha = 1;
  }
  g.fillStyle = GOOD;
  g.beginPath(); g.arc(X(club.x), Y(club.y), 6, 0, Math.PI * 2); g.fill();
}

function renderActiveBanner(frame) {
  const banner = $('active');
  if (!frame.faults.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = frame.faults
    .map((f) => `<span class="chip ${f.severity}">${f.severity === 'major' ? '⨯' : '△'} ${esc(f.label)}</span>`)
    .join('');
}

// ---------- scoring ----------
// Distinct faults (first occurrence each), majors first.
function summarize(results) {
  const seen = new Map();
  for (const f of results) {
    for (const fault of f.faults) {
      if (!seen.has(fault.id)) seen.set(fault.id, { fault, timeMs: f.timeMs, phase: f.phase });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.fault.severity === b.fault.severity
      ? a.timeMs - b.timeMs
      : a.fault.severity === 'major' ? -1 : 1
  );
}

function computeScore(found) {
  let s = 100;
  for (const { fault } of found) s -= fault.severity === 'major' ? 12 : 5;
  s = Math.max(0, Math.round(s));
  const [grade, gradeLabel] =
    s >= 90 ? ['A', 'Tour-ready'] :
    s >= 75 ? ['B', 'Solid swing'] :
    s >= 60 ? ['C', 'Getting there'] :
    s >= 40 ? ['D', 'Needs range time'] : ['E', 'Rebuild the base'];
  return { score: s, grade, gradeLabel };
}

// ---------- results ----------
function renderAll() {
  const el = $('results');
  if (!state.results) {
    el.innerHTML = '';
    $('plan').innerHTML = '';
    renderHistory();
    return;
  }
  const found = summarize(state.results);
  const { score, grade, gradeLabel } = computeScore(found);
  const hasVideo = !!video.src;

  const metrics = measureCheckpoints(state.results, state.ideal);
  const metricsHtml = metrics.length ? `
    <div class="panel">
      <div class="section">Checkpoints — you vs your model</div>
      <table class="metrics-table">
        <thead><tr><th scope="col">Checkpoint</th><th scope="col">You</th><th scope="col">Target</th><th scope="col"></th></tr></thead>
        <tbody>${metrics.map(metricRow).join('')}</tbody>
      </table>
    </div>` : '';
  const clubHtml = renderClubPanel();

  el.innerHTML = `
    <div class="scorecard">
      <div class="score-big">${score}<span class="grade-pill">${grade}</span></div>
      <div class="score-label">${esc(gradeLabel)} · ${found.length === 0 ? 'no faults found' : `${found.length} fix${found.length === 1 ? '' : 'es'} found`}${state.isSample ? ' · sample swing' : ''}</div>
      <div class="score-sub">${hasVideo && !state.isSample ? 'Tap a fault to jump to it in the video.' : 'Red = major · Amber = minor.'} Each comes with a drill.</div>
      <button class="ghost share" id="share">Download summary card (PNG)</button>
    </div>
    ${metricsHtml}
    ${clubHtml}
    ${found.map((row) => faultCard(row, hasVideo && !state.isSample)).join('')}`;

  el.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      video.currentTime = Number(btn.dataset.jump) / 1000;
      video.pause();
      $('stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  $('share').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = 'swing-coach-summary.png';
    a.href = makeSummaryDataUrl();
    a.click();
  });

  renderPlan(found);
  renderHistory();
}

function metricRow(r) {
  // Club rows carry fractional targets (a 3.0:1 tempo, a 1.5" low point), so
  // only whole-degree body targets get rounded.
  const n = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
  const you = r.measured == null ? '—' : `${n(r.measured)}${r.unit}`;
  const target =
    r.kind === 'info' || r.target == null ? '—' :
    r.kind === 'range' ? `${n(r.target[0])}–${n(r.target[1])}${r.unit}` :
    r.kind === 'min' ? `≥ ${n(r.target)}${r.unit}` : `≤ ${n(r.target)}${r.unit}`;
  const mark = r.ok == null ? '<span class="na">·</span>' : r.ok ? '<span class="ok">✓</span>' : '<span class="bad">⨯</span>';
  return `<tr><td>${esc(r.label)}</td><td class="num">${you}</td><td class="num">${target}</td><td>${mark}</td></tr>`;
}

// ---------- club & ball panel ----------
// Separate from the body checkpoints because these numbers come from a
// different kind of measurement — pixels rather than landmarks — and carry
// different caveats. Saying so is part of the result.
function renderClubPanel() {
  const m = state.club;
  if (!m) return '';
  const targets = clubTargets(state.ideal.profile, state.sensitivity);
  const rows = clubCheckpointRows(m, targets, state.units);

  const notes = [];
  // Tempo needs no pixels, so it turns up even when tracking found nothing at
  // all — which would otherwise leave a club panel with no hint that the club
  // part of it silently failed.
  if (m.quality === 'none') {
    notes.push("Couldn't follow the clubhead in this clip, so only tempo is shown. Club tracking needs a plain, contrasty background and the club in frame through the whole swing.");
  } else if (m.quality === 'weak') {
    notes.push('The clubhead was only picked up intermittently, so the arc could not be measured reliably. Try better light or a plainer background.');
  }
  if (m.slowMo) {
    notes.push('This looks like a slow-mo clip, so clubhead speed is left out — the tempo ratio is unaffected by slow motion.');
  }
  if (m.speedMph != null) {
    notes.push('Speed is estimated from a face-on 2D arc and reads low against a launch monitor. Track it against itself, not against the range.');
  }
  if (m.lowPointCm != null && targets.lowPointMinCm != null) {
    notes.push(m.ballDetected
      ? 'Ball found in the picture, so the low point is measured against the real thing.'
      : 'No ball visible at address — the low point is measured against where your stance says it should be.');
  }
  // The tracer's limit is physics, not code: a struck ball crosses a frame
  // this size in about 1/30s, so normal-speed video has nothing to follow.
  if (m.tracerQuality === 'ok') {
    notes.push(`Ball tracer: followed the ball for ${m.flightPoints} frames off the face. Launch angle is measured from that line.`);
  } else if (!state.isSample) {
    notes.push(m.tracerQuality === 'weak'
      ? 'The ball was only caught in one frame after impact, which is not enough for a tracer. A slow-mo clip (120/240fps) gives it several.'
      : 'No ball tracer: at normal speed a struck ball crosses the whole frame between one frame and the next. Film in slow-mo (120/240fps) and it can follow the flight.');
  }
  if (state.isSample) notes.push('Sample swing: the stick figure is schematic, so speed is not computed for it.');

  if (!rows.length && !notes.length) return '';
  return `
    <div class="panel">
      <div class="section">Club &amp; ball</div>
      ${rows.length ? `
        <table class="metrics-table">
          <thead><tr><th scope="col">Measurement</th><th scope="col">You</th><th scope="col">Target</th><th scope="col"></th></tr></thead>
          <tbody>${rows.map(metricRow).join('')}</tbody>
        </table>` : ''}
      ${notes.map((t) => `<div class="note">${esc(t)}</div>`).join('')}
    </div>`;
}

function faultCard({ fault, timeMs, phase }, hasVideo) {
  const drill = drillFor(fault.id);
  const t = (timeMs / 1000).toFixed(2);
  return `
    <div class="fault-card ${fault.severity}">
      <div class="fault-head">
        <span class="phase-tag">${esc(phase)}</span>
        ${hasVideo ? `<button class="jump" data-jump="${timeMs}">▶ ${t}s</button>` : `<span class="time">${t}s</span>`}
      </div>
      <div class="fault-label ${fault.severity}">${fault.severity === 'major' ? '⨯' : '△'} ${esc(fault.label)}</div>
      <div class="fault-tip"><span>In the moment:</span> ${esc(fault.tip)}</div>
      ${drill ? `
        <div class="drill">
          <div class="drill-name">Drill · ${esc(drill.name)}</div>
          <ol>${drill.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        </div>` : ''}
    </div>`;
}

// ---------- practice plan ----------
function renderPlan(found) {
  const el = $('plan');
  if (!found.length) { el.innerHTML = ''; return; }
  const top = found.slice(0, 3);
  el.innerHTML = `
    <div class="panel">
      <div class="section">This week's practice plan</div>
      ${top.map((r, i) => {
        const d = drillFor(r.fault.id);
        return `
        <div class="plan-item">
          <div class="plan-rank">Priority ${i + 1}${r.fault.severity === 'major' ? '' : ' · minor'}</div>
          <div class="plan-name">${esc(d ? d.name : r.fault.id)}</div>
          <div class="plan-why">${esc(r.fault.label)}</div>
          <div class="plan-reps">3 sets of 10 slow reps, then 5 balls at 80% speed.</div>
        </div>`;
      }).join('')}
      <div class="plan-foot">Chase one fix at a time — re-film and re-analyze after each session.</div>
      <button class="ghost" id="print-plan">Print / save as PDF</button>
    </div>`;
  $('print-plan').addEventListener('click', () => window.print());
}

// ---------- progress history (stays on this device) ----------
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function recordHistory() {
  const found = summarize(state.results);
  const { score } = computeScore(found);
  const h = loadHistory();
  h.push({
    t: Date.now(),
    score,
    majors: found.filter((f) => f.fault.severity === 'major').length,
    minors: found.filter((f) => f.fault.severity === 'minor').length,
    sample: state.isSample,
  });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50))); } catch { /* storage full/blocked */ }
}
function renderHistory() {
  const el = $('history');
  const h = loadHistory();
  if (!h.length) { el.innerHTML = ''; return; }
  const last = h.slice(-12);
  const w = 240, ht = 48;
  const xs = last.map((_, i) => (last.length === 1 ? w / 2 : ((w - 8) * i) / (last.length - 1) + 4));
  const ys = last.map((e) => ht - 6 - (ht - 12) * (e.score / 100));
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  el.innerHTML = `
    <div class="panel">
      <div class="section">Progress</div>
      <svg class="spark" viewBox="0 0 ${w} ${ht}" role="img" aria-label="Swing score trend">
        ${last.length > 1 ? `<polyline points="${pts}" fill="none" stroke="${GOOD}" stroke-width="2"/>` : ''}
        ${xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3" fill="${GOOD}"/>`).join('')}
      </svg>
      <div class="hist-rows">
        ${h.slice(-6).reverse().map((e) => `
          <div class="hist-row">
            <span>${new Date(e.t).toLocaleDateString()} ${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>${e.sample ? '<em class="sample">sample</em>' : ''}</span>
            <span class="hist-score">${e.score}</span>
          </div>`).join('')}
      </div>
      <button class="ghost" id="clear-history">Clear history</button>
    </div>`;
  $('clear-history').addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });
}

// ---------- shareable summary card ----------
function makeSummaryDataUrl() {
  const found = state.results ? summarize(state.results) : [];
  const { score, grade, gradeLabel } = computeScore(found);
  const c = document.createElement('canvas');
  c.width = 1000; c.height = 625;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, 625);
  bg.addColorStop(0, '#0c3120'); bg.addColorStop(1, '#061b10');
  g.fillStyle = bg; g.fillRect(0, 0, 1000, 625);
  g.fillStyle = CHALK; g.font = '900 44px system-ui'; g.fillText('SWING COACH PRO', 60, 96);
  g.fillStyle = '#9dbfa9'; g.font = '20px system-ui'; g.fillText(new Date().toLocaleDateString(), 60, 130);
  g.fillStyle = CHALK; g.font = '900 130px system-ui'; g.fillText(String(score), 60, 280);
  g.font = '800 40px system-ui'; g.fillText(`${grade} · ${gradeLabel}`, 60, 340);

  const m = state.club;
  const clubBits = [];
  if (m) {
    if (m.tempoRatio != null) clubBits.push(`tempo ${m.tempoRatio.toFixed(1)}:1`);
    if (m.speedMph != null) clubBits.push(`${m.speedMph} mph est.`);
    if (m.attackAngle != null) clubBits.push(`attack ${m.attackAngle > 0 ? '+' : ''}${m.attackAngle.toFixed(1)}°`);
  }
  if (clubBits.length) {
    g.fillStyle = GOOD; g.font = '700 22px system-ui';
    g.fillText(clubBits.join('   ·   '), 60, 376);
  }

  g.fillStyle = '#9dbfa9'; g.font = '700 22px system-ui';
  g.fillText(found.length ? 'Top fixes:' : 'No faults crossed your thresholds.', 60, 404);
  g.font = '20px system-ui';
  found.slice(0, 3).forEach((r, i) => {
    const d = drillFor(r.fault.id);
    const y = 440 + i * 58;
    g.fillStyle = r.fault.severity === 'major' ? FLAG : AMBER;
    g.fillText('⨯', 60, y);
    g.fillStyle = CHALK;
    g.fillText(r.fault.label.slice(0, 72), 88, y);
    g.fillStyle = GOOD;
    g.fillText(`Drill: ${d ? d.name : '—'}`, 88, y + 24);
  });
  g.fillStyle = '#9dbfa9'; g.font = '16px system-ui';
  g.fillText('Analyzed entirely in the browser · Swing Coach Pro', 60, 600);
  return c.toDataURL('image/png');
}

// ---------- live stance check ----------
// The engine treats a lone frame as the setup position (labelPhases marks
// frame 0 as 'setup'), so one-frame analysis IS a stance check — the same
// spine-tilt and knee-flex faults, tips and thresholds as video analysis,
// running live on the webcam.
let liveStream = null;
let liveRunning = false;

async function startStance() {
  setStatus('');
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' }, audio: false,
    });
  } catch (e) {
    setStatus('Camera unavailable: ' + (e.message || e.name) + '. Allow camera access and try again.', true);
    return;
  }
  const v = $('live-video');
  v.srcObject = liveStream;
  try { await v.play(); } catch { /* autoplay quirks — playsinline covers iOS */ }
  $('live-stage').hidden = false;
  $('stance-stop').hidden = false;
  $('stance').hidden = true;
  liveRunning = true;
  liveLoop();
}

async function liveLoop() {
  const v = $('live-video');
  while (liveRunning) {
    if (v.videoWidth) {
      let frame = null;
      try { frame = await detectLiveFrame(v); } catch { /* transient */ }
      if (liveRunning) drawLive(frame, v);
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function drawLive(frame, v) {
  const cvs = $('live-overlay');
  const rect = v.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  if (cvs.width !== Math.round(rect.width * dpr)) {
    cvs.width = Math.round(rect.width * dpr);
    cvs.height = Math.round(rect.height * dpr);
    cvs.style.width = rect.width + 'px';
    cvs.style.height = rect.height + 'px';
  }
  const g = cvs.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, rect.width, rect.height);

  const chips = $('live-chips');
  if (!frame) {
    chips.hidden = false;
    chips.innerHTML = '<span class="chip minor">Step back — whole body in frame</span>';
    return;
  }
  const analyzed = analyzeFrames(labelPhases([frame], state.ideal.profile.handedness), state.ideal);
  const faults = analyzed[0].faults;
  drawSkeleton(g, analyzed[0], rect.width / frame.width);
  chips.hidden = false;
  chips.innerHTML = faults.length === 0
    ? '<span class="chip good-chip">✓ Stance on plan — swing away</span>'
    : faults.map((f) =>
        `<span class="chip ${f.severity}">${f.severity === 'major' ? '⨯' : '△'} ${esc(f.label)}</span>`
      ).join('');
}

function stopStance() {
  liveRunning = false;
  if (liveStream) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
  }
  const v = $('live-video');
  v.srcObject = null;
  $('live-stage').hidden = true;
  $('stance-stop').hidden = true;
  $('stance').hidden = false;
  $('live-chips').innerHTML = '';
}

$('stance').addEventListener('click', startStance);
$('stance-stop').addEventListener('click', stopStance);
// Picking or analyzing a video ends the live session and frees the camera.
$('file').addEventListener('change', stopStance);
$('analyze').addEventListener('click', stopStance);

// ---------- suggestion box ----------
// Suggestions open the visitor's own mail app, pre-addressed to the owner —
// no account and no backend, and submissions land straight in the inbox.
const SUGGEST_TO = 'wmalinzak@gmail.com';

function buildSuggestionUrl(text) {
  const t = String(text || '').trim();
  const body = (t || '') + '\n\n— Sent from the suggestion box on the Swing Coach Pro site.';
  return `mailto:${SUGGEST_TO}?subject=${encodeURIComponent('Swing Coach Pro suggestion')}` +
    `&body=${encodeURIComponent(body)}`;
}

function sendSuggestion() {
  const el = $('suggest-text');
  if (!el.value.trim()) { el.focus(); return; }
  // location.href is the reliable way to trigger mailto on mobile Safari —
  // window.open can leave a dead blank tab behind.
  window.location.href = buildSuggestionUrl(el.value);
  el.value = '';
  const note = $('suggest-note');
  if (note) note.textContent = 'Opening your email app — just tap Send. Thanks! ⛳';
}
$('suggest-send').addEventListener('click', sendSuggestion);
$('suggest-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendSuggestion();
});

// ---------- PWA ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is optional */ });
}

// Hooks for the automated in-browser checks; harmless in production.
window.__scp = {
  totalFaults: () => (state.results ? state.results.reduce((n, f) => n + f.faults.length, 0) : -1),
  summaryCardLength: () => makeSummaryDataUrl().length,
  suggestionUrl: buildSuggestionUrl,
};

// ---------- boot ----------
fillUnitFields();
renderModel();
renderHistory();
