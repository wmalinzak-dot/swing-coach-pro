// Tests the club/ball tracking maths.
//
// This one imports from docs/ rather than src/. Club tracking is web-only —
// the native app has no cheap pixel access on the JS thread — so docs/clubTrack.js
// is the single implementation rather than one half of a port pair. Testing the
// file that actually ships beats testing a copy of it.
//
// Everything below runs in Node: sampleGrey/sampleGreyRegion are the only
// canvas-touching functions in that module and nothing here calls them. The
// pixel tracker is exercised against synthetic greyscale frames — a bright dot
// moved by hand — which proves the search geometry, not real-world robustness.

import {
  fitCircle, estimatePxPerCm, estimateBallPoint, targetDirection, placeBall,
  trackClubhead, clubMetrics, clubTargets, clubFaults, applyClubFaults,
  clubCheckpointRows, CLUB_LENGTH_CM, TRACK_W,
} from '../../docs/clubTrack';
import { buildIdealModel, labelPhases, analyzeFrames } from '../../docs/engine';
import { buildDemoSwing } from '../../docs/demo';

const IDEAL = buildIdealModel({
  heightCm: 178, weightKg: 80, wingspanCm: 178, age: 35,
  flexibility: 'average', handedness: 'right', club: 'driver',
});
const IRON = buildIdealModel({ ...IDEAL.profile, club: 'iron' });

const k = (x, y, score = 0.9) => ({ x, y, z: 0, score });

// A body scaled so nose→ankle is 550px. At 178cm that is ~3.6 px/cm.
function body({ wristY = 500, leadAnkleX = 370, trailAnkleX = 430 } = {}) {
  return {
    nose: k(400, 200),
    left_shoulder: k(360, 300), right_shoulder: k(440, 300),
    left_elbow: k(360, (300 + wristY) / 2), right_elbow: k(486, (300 + wristY) / 2),
    left_wrist: k(390, wristY), right_wrist: k(410, wristY),
    left_hip: k(370, 450), right_hip: k(430, 450),
    left_knee: k(396, 600), right_knee: k(456, 600),
    left_ankle: k(leadAnkleX, 750), right_ankle: k(trailAnkleX, 750),
    left_heel: k(leadAnkleX - 10, 760), right_heel: k(trailAnkleX - 10, 760),
    left_foot_index: k(leadAnkleX + 20, 755), right_foot_index: k(trailAnkleX + 20, 755),
  };
}

describe('fitCircle — the arc every club number is read from', () => {
  it('recovers a circle from points on it', () => {
    const c = { cx: 300, cy: 120, r: 260 };
    const pts = [20, 55, 90, 140, 200].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) };
    });
    const fit = fitCircle(pts);
    expect(fit.cx).toBeCloseTo(c.cx, 3);
    expect(fit.cy).toBeCloseTo(c.cy, 3);
    expect(fit.r).toBeCloseTo(c.r, 3);
  });

  it('shrugs off a little noise on each point', () => {
    const c = { cx: 400, cy: 200, r: 300 };
    const jitter = [1.4, -2.1, 0.8, -1.2, 2.0, -0.6];
    const pts = jitter.map((j, i) => {
      const a = ((30 + i * 25) * Math.PI) / 180;
      return { x: c.cx + (c.r + j) * Math.cos(a), y: c.cy + (c.r + j) * Math.sin(a) };
    });
    const fit = fitCircle(pts);
    expect(Math.abs(fit.r - c.r)).toBeLessThan(4);
    expect(Math.hypot(fit.cx - c.cx, fit.cy - c.cy)).toBeLessThan(4);
  });

  it('refuses collinear points instead of inventing a circle', () => {
    expect(fitCircle([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }])).toBeNull();
  });

  it('needs at least three points', () => {
    expect(fitCircle([{ x: 0, y: 0 }, { x: 4, y: 9 }])).toBeNull();
  });
});

describe('scale and reference points', () => {
  it('derives pixels-per-cm from the player’s own height', () => {
    const px = estimatePxPerCm([{ keypoints: body() }], IDEAL.profile);
    // 550px of nose-to-ankle over 178cm × 0.855.
    expect(px).toBeCloseTo(550 / (178 * 0.855), 4);
  });

  it('returns null rather than guessing when the body is not visible', () => {
    expect(estimatePxPerCm([{ keypoints: { nose: k(1, 1) } }], IDEAL.profile)).toBeNull();
  });

  it('reads the target direction from the stance, not from handedness alone', () => {
    // Lead ankle left of trail ankle → the target is toward smaller x.
    expect(targetDirection(body(), 'right')).toBe(-1);
    // Mirror the stance and the answer flips, which is what a mirrored camera
    // or a left-hander needs.
    expect(targetDirection(body({ leadAnkleX: 430, trailAnkleX: 370 }), 'right')).toBe(1);
  });

  it('moves the assumed ball forward for a driver and back for a wedge', () => {
    const dir = targetDirection(body(), 'right'); // -1: target is toward smaller x
    const driver = estimateBallPoint(body(), { ...IDEAL.profile, club: 'driver' });
    const wedge = estimateBallPoint(body(), { ...IDEAL.profile, club: 'wedge' });
    // "Forward" means toward the target.
    expect((driver.x - wedge.x) * dir).toBeGreaterThan(0);
    // Both sit on the ground line, not at ankle height.
    expect(driver.y).toBe(760);
  });

  it('marks an assumed ball as estimated so the UI can say so', () => {
    expect(estimateBallPoint(body(), IDEAL.profile).estimated).toBe(true);
  });
});

// --- the pixel tracker, against synthetic footage -------------------------
//
// Frames are plain greyscale buffers with one bright disc standing in for the
// clubhead. This checks the search geometry — annulus, masking, continuity —
// finds a moving blob at roughly one club length from the hands.

function greyFrame(w, h, dots) {
  const data = new Uint8Array(w * h).fill(40);
  for (const d of dots) {
    for (let y = Math.max(0, d.y - d.r); y <= Math.min(h - 1, d.y + d.r); y++) {
      for (let x = Math.max(0, d.x - d.r); x <= Math.min(w - 1, d.x + d.r); x++) {
        if (Math.hypot(x - d.x, y - d.y) <= d.r) data[y * w + x] = d.v ?? 235;
      }
    }
  }
  return { data, w, h };
}

// Build a swing whose "clubhead" is a bright disc moving along a known arc.
function syntheticTrack(angles, { club = 'driver' } = {}) {
  const W = 800, H = 900;
  const gw = TRACK_W, gh = Math.round((H / W) * TRACK_W);
  const scale = gw / W;
  const pxPerCm = 550 / (178 * 0.855);
  const radius = CLUB_LENGTH_CM[club] * 0.9 * pxPerCm; // what the tracker expects
  const hands = { x: 400, y: 500 };

  return angles.map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const cx = hands.x + radius * Math.sin(a);
    const cy = hands.y + radius * Math.cos(a);
    return {
      timeMs: i * 33,
      width: W,
      height: H,
      keypoints: body({ wristY: 500 }),
      grey: greyFrame(gw, gh, [{
        x: Math.round(cx * scale), y: Math.round(cy * scale), r: 3,
      }]),
      truth: { x: cx, y: cy },
    };
  });
}

describe('trackClubhead — finds the moving club in the picture', () => {
  it('follows a bright blob around the swing arc', () => {
    const frames = syntheticTrack([170, 140, 110, 80, 50, 20, -10, -40]);
    const track = trackClubhead(frames, IDEAL);

    expect(track.pxPerCm).toBeGreaterThan(0);
    expect(track.radiusPx).toBeGreaterThan(0);
    // The first frame has nothing to difference against, so it is geometric.
    expect(track.tracked).toBeGreaterThanOrEqual(frames.length - 2);

    const errors = frames.slice(1)
      .filter((f) => f.keypoints.clubhead)
      .map((f) => Math.hypot(f.keypoints.clubhead.x - f.truth.x, f.keypoints.clubhead.y - f.truth.y));
    // Tracking happens at TRACK_W, so a few full-resolution pixels of slop is
    // the resolution floor, not an error.
    expect(Math.max(...errors)).toBeLessThan(25);
  });

  it('puts the address clubhead on the ball, where geometry knows it is', () => {
    const frames = syntheticTrack([170, 140, 110, 80]);
    const ball = { x: 374, y: 755 };
    trackClubhead(frames, IDEAL, ball);
    const c = frames[0].keypoints.clubhead;
    expect(c).toBeTruthy();
    // On the hands→ball line, one club length out.
    const hands = { x: 400, y: 500 };
    const toBall = Math.atan2(ball.y - hands.y, ball.x - hands.x);
    const toClub = Math.atan2(c.y - hands.y, c.x - hands.x);
    expect(Math.abs(toBall - toClub)).toBeLessThan(0.02);
  });

  it('reports nothing rather than guessing when there are no pixels', () => {
    const frames = syntheticTrack([170, 140, 110]).map(({ grey, ...f }) => f);
    const track = trackClubhead(frames, IDEAL);
    expect(track.tracked).toBe(0);
  });

  it('ignores a still bright object and follows the moving one', () => {
    // A distractor sits inside the search annulus but never moves, so it makes
    // no frame difference — motion is what separates club from background.
    const frames = syntheticTrack([170, 140, 110, 80, 50, 20]);
    const gw = frames[0].grey.w;
    for (const f of frames) {
      for (let y = 20; y < 26; y++) {
        for (let x = 20; x < 26; x++) f.grey.data[y * gw + x] = 250;
      }
    }
    trackClubhead(frames, IDEAL);
    const errs = frames.slice(1)
      .filter((f) => f.keypoints.clubhead)
      .map((f) => Math.hypot(f.keypoints.clubhead.x - f.truth.x, f.keypoints.clubhead.y - f.truth.y));
    expect(errs.length).toBeGreaterThan(2);
    expect(Math.max(...errs)).toBeLessThan(25);
  });
});

// --- metrics --------------------------------------------------------------

// A swing with an explicit clubhead arc, so the metrics can be checked against
// geometry that is known exactly. `angles` are positions on the circle; 0 is
// the bottom of the arc.
function arcSwing({
  centre = { x: 360, y: 430 }, r = 325,
  angles = [78, 42, 2.5, -42, -85],
  times = [833, 900, 967, 1067, 1200],
  ball = { x: 374, y: 755 },
} = {}) {
  const pre = [
    { t: 0, wristY: 500 }, { t: 250, wristY: 430 },
    { t: 500, wristY: 330 }, { t: 750, wristY: 215 },
  ];
  const frames = pre.map(({ t, wristY }) => ({
    timeMs: t, width: 800, height: 900, keypoints: body({ wristY }),
  }));
  frames[0].keypoints.ball = { ...ball, score: 0.9, estimated: false };
  const wristTrack = [290, 400, 505, 400, 300];
  angles.forEach((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const kp = body({ wristY: wristTrack[i] ?? 400 });
    kp.clubhead = k(centre.x + r * Math.sin(a), centre.y + r * Math.cos(a));
    frames.push({ timeMs: times[i], width: 800, height: 900, keypoints: kp });
  });
  return frames;
}

const measure = (frames, ideal) =>
  clubMetrics(analyzeFrames(labelPhases(frames, ideal.profile.handedness), ideal), ideal);

describe('placeBall — the ball stays put until the club gets there', () => {
  const labelled = () => labelPhases(arcSwing(), 'right');

  it('carries the address ball forward to every frame up to impact', () => {
    const frames = placeBall(labelled(), { x: 374, y: 755, estimated: false });
    const upToImpact = [];
    for (const f of frames) {
      upToImpact.push(f);
      if (f.phase === 'impact') break;
    }
    expect(upToImpact.every((f) => f.keypoints.ball)).toBe(true);
    expect(upToImpact.length).toBeGreaterThan(3);
  });

  it('stops at impact — after that the ball has gone', () => {
    const frames = placeBall(labelled(), { x: 374, y: 755, estimated: false });
    const after = frames.slice(frames.findIndex((f) => f.phase === 'impact') + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((f) => f.keypoints.ball)).toBe(false);
  });

  it('does nothing when no ball was ever located', () => {
    const bare = labelled();
    delete bare[0].keypoints.ball;
    expect(placeBall(bare, null).some((f) => f.keypoints.ball)).toBe(false);
  });
});

describe('clubMetrics — tempo', () => {
  it('reports the backswing-to-downswing ratio', () => {
    const m = measure(arcSwing(), IDEAL);
    // 750ms back, 217ms down.
    expect(m.tempoRatio).toBeCloseTo(3.5, 1);
    expect(m.backswingMs).toBe(750);
    expect(m.downswingMs).toBe(217);
  });

  it('works with no club track at all — it is pure timing', () => {
    const frames = arcSwing();
    for (const f of frames) delete f.keypoints.clubhead;
    const m = measure(frames, IDEAL);
    expect(m.tempoRatio).toBeGreaterThan(0);
    expect(m.attackAngle).toBeNull();
    expect(m.quality).toBe('none');
  });

  it('flags a slow-mo clip and withholds the speed it would misreport', () => {
    const slow = arcSwing({ times: [2500, 2700, 2900, 3100, 3300] });
    // Push the backswing out to match, so the whole clip is slow-motion.
    slow[1].timeMs = 750; slow[2].timeMs = 1500; slow[3].timeMs = 2250;
    const m = measure(slow, IDEAL);
    expect(m.slowMo).toBe(true);
    expect(m.speedMph).toBeNull();
    // The ratio is scale-free, so slow motion cannot distort it.
    expect(m.tempoRatio).toBeGreaterThan(0);
  });
});

describe('clubMetrics — attack angle and low point come off the fitted arc', () => {
  it('reads a descending blow when the ball is reached before the low point', () => {
    // Bottom of the arc is at x=360; the ball at 374 is reached first, and the
    // target is toward smaller x, so the club is still going down.
    const m = measure(arcSwing(), IDEAL);
    expect(m.quality).toBe('ok');
    expect(m.attackAngle).toBeLessThan(0);
    expect(m.attackAngle).toBeCloseTo(-2.5, 0);
  });

  it('reads an ascending blow when the low point comes first', () => {
    // Put the impact position past the bottom of the arc — the club has already
    // gone through its low point and is climbing.
    const m = measure(arcSwing({ angles: [78, 42, -2.5, -42, -85] }), IDEAL);
    expect(m.attackAngle).toBeGreaterThan(0);
    expect(m.attackAngle).toBeCloseTo(2.5, 0);
  });

  it('measures the low point against the ball, signed toward the target', () => {
    const m = measure(arcSwing(), IRON);
    // Arc bottoms at x=360, ball at x=374, target toward smaller x → 14px past
    // the ball, and ~3.6px per cm.
    expect(m.lowPointCm).toBeGreaterThan(0);
    expect(m.lowPointCm).toBeCloseTo(14 / (550 / (178 * 0.855)), 0);
  });

  it('calls a low point behind the ball negative', () => {
    // The target is toward smaller x here, so an arc bottoming at x=420 — on
    // the far side of the ball at 374 — has not reached the ball yet.
    const m = measure(arcSwing({ centre: { x: 420, y: 430 } }), IRON);
    expect(m.lowPointCm).toBeLessThan(0);
  });

  it('estimates a clubhead speed from radius × angular velocity', () => {
    const m = measure(arcSwing(), IDEAL);
    expect(m.speedMph).toBeGreaterThan(0);
    // 325px radius ≈ 90cm; the fastest sampled sweep is ~39.5° in 67ms.
    const expected = (325 / (550 / (178 * 0.855))) * ((39.5 * Math.PI) / 180 / 0.067) * 0.02236936;
    expect(Math.abs(m.speedMph - expected)).toBeLessThan(3);
  });

  it('rejects an implausible arc rather than reporting nonsense', () => {
    // A "track" that wanders in a straight line has no circle in it.
    const frames = arcSwing();
    let x = 300;
    for (const f of frames) {
      if (f.keypoints.clubhead) { f.keypoints.clubhead = k(x, 600); x += 40; }
    }
    const m = measure(frames, IDEAL);
    expect(m.attackAngle).toBeNull();
    expect(m.lowPointCm).toBeNull();
  });
});

describe('clubTargets — what each club is asked for', () => {
  it('wants the driver struck upward and the iron downward', () => {
    expect(clubTargets({ club: 'driver' }).attackAngle[1]).toBeGreaterThan(0);
    expect(clubTargets({ club: 'iron' }).attackAngle[1]).toBeLessThanOrEqual(0);
  });

  it('skips the low-point check for a teed driver, where it is meaningless', () => {
    expect(clubTargets({ club: 'driver' }).lowPointMinCm).toBeNull();
    expect(clubTargets({ club: 'iron' }).lowPointMinCm).not.toBeNull();
  });

  it('widens on relaxed and narrows on strict', () => {
    const relaxed = clubTargets({ club: 'iron' }, 'relaxed');
    const strict = clubTargets({ club: 'iron' }, 'strict');
    expect(relaxed.lagMax).toBeGreaterThan(strict.lagMax);
    expect(relaxed.tempo[0]).toBeLessThan(strict.tempo[0]);
    expect(relaxed.tempo[1]).toBeGreaterThan(strict.tempo[1]);
  });
});

describe('clubFaults — fires on real faults, stays quiet otherwise', () => {
  const targets = clubTargets(IRON.profile);
  const idsFor = (over) =>
    clubFaults({
      tempoRatio: 3.0, lagAngle: 80, attackAngle: -3, lowPointCm: 4, ...over,
    }, targets, IRON.profile).map((f) => f.id);

  it('says nothing about a swing that meets every target', () => {
    expect(idsFor({})).toEqual([]);
  });

  it('flags a cast', () => {
    expect(idsFor({ lagAngle: 155 })).toContain('casting');
  });

  it('flags scooping when the iron is on the way up', () => {
    expect(idsFor({ attackAngle: 4 })).toContain('scooping');
  });

  it('flags hitting down on a driver, with the driver-specific advice', () => {
    const faults = clubFaults(
      { tempoRatio: 3, attackAngle: -4 }, clubTargets({ club: 'driver' }), IDEAL.profile
    );
    expect(faults.map((f) => f.id)).toContain('driver-hitting-down');
    expect(faults.find((f) => f.id === 'driver-hitting-down').tip).toMatch(/tee/i);
  });

  it('flags a low point behind the ball', () => {
    expect(idsFor({ lowPointCm: -5 })).toContain('low-point-behind-ball');
  });

  it('flags tempo at both ends', () => {
    expect(idsFor({ tempoRatio: 1.4 })).toContain('rushed-transition');
    expect(idsFor({ tempoRatio: 6 })).toContain('lazy-transition');
  });

  it('gives every club fault what the overlay and the plan need', () => {
    const all = [
      ...idsFor({ lagAngle: 155 }), ...idsFor({ attackAngle: 4 }),
      ...idsFor({ lowPointCm: -5 }), ...idsFor({ tempoRatio: 1.4 }),
    ];
    expect(all.length).toBeGreaterThan(3);
    const faults = clubFaults(
      { tempoRatio: 1.4, lagAngle: 155, attackAngle: 4, lowPointCm: -5 }, targets, IRON.profile
    );
    for (const f of faults) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.tip).toBe('string');
      expect(['major', 'minor']).toContain(f.severity);
      expect(Array.isArray(f.edges)).toBe(true);
      expect(f.circleAround.length).toBeGreaterThan(0);
      expect(['setup', 'backswing', 'top', 'downswing', 'impact', 'follow-through']).toContain(f.at);
    }
  });
});

describe('applyClubFaults — a guessed number must not cost anybody score', () => {
  const frames = () => analyzeFrames(labelPhases(arcSwing(), 'right'), IRON);
  const targets = clubTargets(IRON.profile);

  it('attaches faults to the phase they belong to', () => {
    const bad = { quality: 'ok', tempoRatio: 3, lagAngle: 160, attackAngle: 5, lowPointCm: -6 };
    const out = applyClubFaults(frames(), bad, targets, IRON.profile);
    const at = (phase) => out.filter((f) => f.phase === phase).flatMap((f) => f.faults.map((x) => x.id));
    expect(at('downswing')).toContain('casting');
    expect(at('impact')).toContain('scooping');
    expect(at('impact')).toContain('low-point-behind-ball');
  });

  it('withholds arc-derived faults when the track was too weak to trust', () => {
    const weak = { quality: 'weak', tempoRatio: 3, lagAngle: 160, attackAngle: 5, lowPointCm: -6 };
    const ids = applyClubFaults(frames(), weak, targets, IRON.profile)
      .flatMap((f) => f.faults.map((x) => x.id));
    expect(ids).not.toContain('casting');
    expect(ids).not.toContain('scooping');
    expect(ids).not.toContain('low-point-behind-ball');
  });

  it('still reports tempo when the club was never found — it needs no pixels', () => {
    const weak = { quality: 'none', tempoRatio: 1.2 };
    const ids = applyClubFaults(frames(), weak, targets, IRON.profile)
      .flatMap((f) => f.faults.map((x) => x.id));
    expect(ids).toContain('rushed-transition');
  });

  it('leaves the body faults exactly as the engine scored them', () => {
    const before = frames();
    const after = applyClubFaults(before, { quality: 'none' }, targets, IRON.profile);
    expect(after.flatMap((f) => f.faults.map((x) => x.id)))
      .toEqual(before.flatMap((f) => f.faults.map((x) => x.id)));
  });
});

describe('clubCheckpointRows — feeds the same table as the body checkpoints', () => {
  const targets = clubTargets(IRON.profile);
  const metrics = {
    tempoRatio: 3.0, speedMph: 88, attackAngle: -3, lagAngle: 95, lowPointCm: 5,
  };

  it('marks a measurement inside its target as ok', () => {
    const rows = clubCheckpointRows(metrics, targets);
    expect(rows.find((r) => r.label.startsWith('Tempo')).ok).toBe(true);
    expect(rows.find((r) => r.label === 'Attack angle').ok).toBe(true);
  });

  it('marks one outside as not ok', () => {
    const rows = clubCheckpointRows({ ...metrics, attackAngle: 6 }, targets);
    expect(rows.find((r) => r.label === 'Attack angle').ok).toBe(false);
  });

  it('leaves the speed estimate unjudged — there is no target for it', () => {
    const speed = clubCheckpointRows(metrics, targets).find((r) => r.unit === ' mph');
    expect(speed.ok).toBeNull();
  });

  it('converts the low point to inches unless metric is asked for', () => {
    const imperial = clubCheckpointRows(metrics, targets, 'imperial')
      .find((r) => r.label === 'Low point vs ball');
    const metric = clubCheckpointRows(metrics, targets, 'metric')
      .find((r) => r.label === 'Low point vs ball');
    expect(imperial.measured).toBeCloseTo(5 / 2.54, 1);
    expect(metric.measured).toBe(5);
  });

  it('omits rows for measurements that were never taken', () => {
    const rows = clubCheckpointRows({ tempoRatio: 3 }, targets);
    expect(rows).toHaveLength(1);
  });
});

describe('the sample swing exercises the club feature end to end', () => {
  const analyzed = analyzeFrames(labelPhases(buildDemoSwing(), 'right'), IDEAL);
  const m = clubMetrics(analyzed, IDEAL);

  it('carries a clubhead through the downswing and a ball at address', () => {
    expect(analyzed[0].keypoints.ball).toBeTruthy();
    expect(analyzed.filter((f) => f.keypoints.clubhead).length).toBeGreaterThanOrEqual(6);
  });

  it('produces a usable arc, so the sample shows real club numbers', () => {
    expect(m.quality).toBe('ok');
    expect(m.tempoRatio).toBeGreaterThan(2);
    expect(m.tempoRatio).toBeLessThan(4);
    expect(m.attackAngle).not.toBeNull();
  });

  it('demonstrates at least one club fault to show what the feature does', () => {
    const ids = applyClubFaults(analyzed, m, clubTargets(IDEAL.profile), IDEAL.profile)
      .flatMap((f) => f.faults.map((x) => x.id));
    expect(ids).toContain('driver-hitting-down');
  });
});
