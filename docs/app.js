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
import { detectSwing } from './pose.js';
import { drillFor } from './drills.js';
import { buildDemoSwing } from './demo.js';

const FLAG = '#e4353b', AMBER = '#e8a33d', CHALK = '#f2efe6', GOOD = '#8fd6a5';
const KEY_PHASES = ['setup', 'top', 'impact'];
const HISTORY_KEY = 'scp-history';
const FRAME_STEP = 1 / 30;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const state = {
  profile: { ...DEFAULT_PROFILE },
  sensitivity: 'normal',
  ideal: null,
  results: null,
  isSample: false,
  videoObjectUrl: null,
};

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
    `Adjusted for ${p.heightCm} cm, ${p.weightKg} kg (BMI ${state.ideal.bmi}), ${p.flexibility} flexibility, ${p.club}.` +
    (state.sensitivity === 'normal' ? '' : ` Thresholds set to ${state.sensitivity}.`);
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
      if (key === 'sensitivity') state.sensitivity = btn.dataset.val;
      else state.profile[key] = btn.dataset.val;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderModel();
      if (state.results) rescore();
    });
  });
});

// Re-run scoring on an existing pose track when the profile or thresholds change.
function rescore() {
  if (!state.results) return;
  const labeled = labelPhases(state.results.map(stripFault), state.ideal.profile.handedness);
  state.results = analyzeFrames(labeled, state.ideal);
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
    const frames = await detectSwing(video, { fps: 30, maxFrames: 90 }, (i, n) => {
      if (typeof n === 'number') setStatus(`Detecting your body — frame ${i}/${n}…`);
      else setStatus(i);
    });
    if (frames.length < 4) {
      throw new Error('Could not find a full body. Film face-on with your whole body in frame, in good light.');
    }
    const labeled = labelPhases(frames, state.ideal.profile.handedness);
    state.results = analyzeFrames(labeled, state.ideal);
    state.isSample = false;
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

$('demo').addEventListener('click', () => {
  const labeled = labelPhases(buildDemoSwing(), state.ideal.profile.handedness);
  state.results = analyzeFrames(labeled, state.ideal);
  state.isSample = true;
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
  drawSkeleton(frame, scale);
  renderActiveBanner(frame);
}

// Canvas port of FrameOverlay.js: chalk skeleton, faulty edges in red/amber,
// dashed circles around the section to change.
function drawSkeleton(frame, scale) {
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

  el.innerHTML = `
    <div class="scorecard">
      <div class="score-big">${score}<span class="grade-pill">${grade}</span></div>
      <div class="score-label">${esc(gradeLabel)} · ${found.length === 0 ? 'no faults found' : `${found.length} fix${found.length === 1 ? '' : 'es'} found`}${state.isSample ? ' · sample swing' : ''}</div>
      <div class="score-sub">${hasVideo && !state.isSample ? 'Tap a fault to jump to it in the video.' : 'Red = major · Amber = minor.'} Each comes with a drill.</div>
      <button class="ghost share" id="share">Download summary card (PNG)</button>
    </div>
    ${metricsHtml}
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
  const you = r.measured == null ? '—' : `${r.measured}${r.unit}`;
  const target =
    r.kind === 'range' ? `${Math.round(r.target[0])}–${Math.round(r.target[1])}${r.unit}` :
    r.kind === 'min' ? `≥ ${Math.round(r.target)}${r.unit}` : `≤ ${Math.round(r.target)}${r.unit}`;
  const mark = r.ok == null ? '<span class="na">·</span>' : r.ok ? '<span class="ok">✓</span>' : '<span class="bad">⨯</span>';
  return `<tr><td>${esc(r.label)}</td><td class="num">${you}</td><td class="num">${target}</td><td>${mark}</td></tr>`;
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
renderModel();
renderHistory();
