// Swing Coach Pro — web app.
//
// Flow: build the personal model from the profile → upload a swing video →
// MediaPipe detects a pose track → the app's real engine labels phases and
// scores faults → the video plays back with the faulty body parts drawn in
// red/amber at the moment they happen, plus a drill for each.

import {
  buildIdealModel, describeModel, DEFAULT_PROFILE,
  labelPhases, analyzeFrames, resolvePoint, EDGES, MIN_SCORE,
} from './engine.js';
import { detectSwing } from './pose.js';
import { drillFor } from './drills.js';
import { buildDemoSwing } from './demo.js';

const FLAG = '#e4353b', AMBER = '#e8a33d', CHALK = '#f2efe6';
const KEY_PHASES = ['setup', 'top', 'impact'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const state = {
  profile: { ...DEFAULT_PROFILE },
  ideal: null,
  results: null,
  videoObjectUrl: null,
};

// ---------- profile + ideal model ----------
function renderModel() {
  state.ideal = buildIdealModel(state.profile);
  $('model').innerHTML = describeModel(state.ideal)
    .map((l) => {
      const [k, ...rest] = l.split(': ');
      return `<div class="model-line">• ${esc(k)}: <b>${esc(rest.join(': '))}</b></div>`;
    })
    .join('');
  const p = state.ideal.profile;
  $('model-note').textContent =
    `Adjusted for ${p.heightCm} cm, ${p.weightKg} kg (BMI ${state.ideal.bmi}), ${p.flexibility} flexibility, ${p.club}.`;
}

['heightCm', 'weightKg', 'wingspanCm', 'age'].forEach((k) => {
  $(k).addEventListener('input', (e) => {
    state.profile[k] = Number(e.target.value) || 0;
    renderModel();
    if (state.results) rescore();
  });
});
document.querySelectorAll('.seg').forEach((seg) => {
  const key = seg.dataset.key;
  seg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.profile[key] = btn.dataset.val;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderModel();
      if (state.results) rescore();
    });
  });
});

// Re-run scoring on an existing pose track when the profile changes.
function rescore() {
  if (!state.results) return;
  const labeled = labelPhases(state.results.map(stripFault), state.ideal.profile.handedness);
  state.results = analyzeFrames(labeled, state.ideal);
  renderResults();
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
  renderResults();
  video.src = state.videoObjectUrl;
  video.load();
  setStatus('');
});

video.addEventListener('loadedmetadata', () => {
  $('stage').hidden = false;
  $('analyze').disabled = false;
  $('analyze').textContent = 'Analyze my swing';
  sizeCanvas();
});
video.addEventListener('timeupdate', drawCurrentFrame);
video.addEventListener('seeked', drawCurrentFrame);
window.addEventListener('resize', () => { sizeCanvas(); drawCurrentFrame(); });

// ---------- analyze ----------
$('analyze').addEventListener('click', async () => {
  if (!video.src) return;
  const btn = $('analyze');
  btn.disabled = true;
  setStatus('Warming up…');
  try {
    const wasPaused = video.paused;
    video.pause();
    const frames = await detectSwing(video, { fps: 30, maxFrames: 90 }, (i, n) => {
      if (typeof n === 'number') setStatus(`Detecting your body — frame ${i}/${n}…`);
      else setStatus(i);
    });
    if (frames.length < 4) {
      throw new Error('Could not find a full body. Film face-on with your whole body in frame, in good light.');
    }
    const labeled = labelPhases(frames, state.ideal.profile.handedness);
    state.results = analyzeFrames(labeled, state.ideal);
    setStatus('');
    renderResults();
    video.currentTime = 0;
    if (!wasPaused) video.play();
    drawCurrentFrame();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
});

$('demo').addEventListener('click', () => {
  const labeled = labelPhases(buildDemoSwing(), state.ideal.profile.handedness);
  state.results = analyzeFrames(labeled, state.ideal);
  renderResults();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function setStatus(msg) {
  const el = $('status');
  el.textContent = msg;
  el.hidden = !msg;
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

// The analyzed frame closest to the video's current time.
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
  drawSkeleton(frame, scale);
  renderActiveBanner(frame);
}

// Canvas port of FrameOverlay.js: chalk skeleton, faulty edges in red/amber,
// dashed circles around the section to change.
function drawSkeleton(frame, scale) {
  const kp = frame.keypoints;
  const faultEdges = new Map(); // "a|b" -> color
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

  ctx.lineCap = 'round';
  for (const [a, b] of EDGES) {
    const pa = kp[a], pb = kp[b];
    if (!pa || !pb || pa.score < MIN_SCORE || pb.score < MIN_SCORE) continue;
    const key = [a, b].slice().sort().join('|');
    const col = faultEdges.get(key);
    ctx.strokeStyle = col || CHALK;
    ctx.globalAlpha = col ? 1 : 0.85;
    ctx.lineWidth = col ? 6 : 3;
    ctx.beginPath(); ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const e of extraEdges) {
    const pa = resolvePoint(kp, e.a), pb = resolvePoint(kp, e.b);
    if (!pa || !pb) continue;
    ctx.strokeStyle = e.color; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y)); ctx.stroke();
  }
  for (const name in kp) {
    if (kp[name].score < MIN_SCORE) continue;
    ctx.fillStyle = CHALK;
    ctx.beginPath(); ctx.arc(X(kp[name].x), Y(kp[name].y), 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.setLineDash([14 * scale, 8 * scale]);
  for (const c of circles) {
    ctx.strokeStyle = c.color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(X(c.cx), Y(c.cy), c.r * scale, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
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

// ---------- results + drills ----------
function renderResults() {
  const el = $('results');
  if (!state.results) { el.innerHTML = ''; return; }

  // One card per distinct fault, at the first frame it occurs.
  const seen = new Map();
  for (const f of state.results) {
    for (const fault of f.faults) {
      if (!seen.has(fault.id)) seen.set(fault.id, { fault, timeMs: f.timeMs, phase: f.phase });
    }
  }
  const found = [...seen.values()].sort((a, b) => a.timeMs - b.timeMs);
  const total = found.length;
  const hasVideo = !!video.src;

  if (total === 0) {
    el.innerHTML = `<div class="scorecard"><div class="score-big good">Pure.</div>
      <div class="score-sub">No faults crossed your personal thresholds in this swing.</div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="scorecard">
      <div class="score-big">${total} fix${total === 1 ? '' : 'es'} found</div>
      <div class="score-sub">${hasVideo ? 'Tap a fault to jump to it in the video.' : 'Red = major · Amber = minor.'} Each comes with a drill.</div>
    </div>
    ${found.map((row) => faultCard(row, hasVideo)).join('')}`;

  el.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      video.currentTime = Number(btn.dataset.jump) / 1000;
      video.pause();
      $('stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
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

// ---------- boot ----------
renderModel();
