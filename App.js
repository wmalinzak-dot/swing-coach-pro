// Swing Coach Pro — BlazePose (33 landmarks, GPU) swing analyzer.
// Two-pass pipeline:
//   Pass 1: sample the whole clip, detect poses, find the top of the swing
//   Pass 2: pull extra frames through the downswing to nail impact
// Then phases are labeled, faults scored vs YOUR ideal model, and results
// are drawn with red fault lines + dashed circles + fix tips.

import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { buildIdealModel, describeModel, DEFAULT_PROFILE } from './src/idealModel';
import { detectFrame, initPose, resetTracking } from './src/pose';
import { extractFrames, densifyDownswing, extractFramesAt } from './src/videoFrames';
import { labelPhases, analyzeFrames, findTopMs } from './src/analysis';
import FrameOverlay from './src/FrameOverlay';
import SwingCamera from './src/SwingCamera';
import { buildDemoSwing } from './src/demoSwing';

const DEEP = '#082516';
const TURF = '#0E3B24';
const CHALK = '#F2EFE6';
const FLAG = '#E4353B';
const MOSS = '#9DBFA9';

const PASS1_FRAMES = 16; // whole clip
const PASS2_FRAMES = 8; // extra downswing frames
const KEY_PHASES = ['setup', 'top', 'impact'];

export default function App() {
  const { width } = useWindowDimensions();
  const [step, setStep] = useState('profile');
  const [profile, setProfile] = useState({ ...DEFAULT_PROFILE });
  const [ideal, setIdeal] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const set = (k) => (v) => setProfile((p) => ({ ...p, [k]: v }));
  const setNum = (k) => (v) =>
    setProfile((p) => ({ ...p, [k]: v === '' ? '' : Number(v) || 0 }));

  function lockProfile() {
    const clean = {
      ...profile,
      heightCm: Number(profile.heightCm) || DEFAULT_PROFILE.heightCm,
      weightKg: Number(profile.weightKg) || DEFAULT_PROFILE.weightKg,
      wingspanCm:
        Number(profile.wingspanCm) || Number(profile.heightCm) || DEFAULT_PROFILE.wingspanCm,
      age: Number(profile.age) || DEFAULT_PROFILE.age,
    };
    setIdeal(buildIdealModel(clean));
    setStep('analyze');
  }

  async function detectAll(frames, labelPrefix) {
    const detected = [];
    for (let i = 0; i < frames.length; i++) {
      setStatus(`${labelPrefix} ${i + 1}/${frames.length}…`);
      try {
        const d = await detectFrame(frames[i]);
        if (d.poseScore > 0.3) detected.push({ ...frames[i], keypoints: d.keypoints });
      } catch (e) {
        // skip bad frame
      }
    }
    return detected;
  }

  async function pickAndAnalyze() {
    try {
      setResults(null);
      setShowAll(false);
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 1,
      });
      if (res.canceled) return;

      const video = res.assets[0];
      const durMs = Math.max(500, video.duration ?? 3000);
      setBusy(true);
      resetTracking();

      setStatus('Loading BlazePose (GPU)…');
      await initPose();

      // ---- Pass 1: scan the whole swing ----
      const frames1 = await extractFrames(video.uri, durMs, PASS1_FRAMES, (i, n) =>
        setStatus(`Extracting frames ${i}/${n}…`)
      );
      if (frames1.length < 4) throw new Error('Could not read frames from this video.');
      const detected1 = await detectAll(frames1, 'Tracking body');
      if (detected1.length < 4)
        throw new Error('Could not find a full body in the video. Film face-on, whole body visible.');

      // ---- Pass 2: densify the downswing around the top ----
      const topMs = findTopMs(detected1, ideal.profile.handedness);
      const frames2 = await densifyDownswing(video.uri, topMs, durMs, PASS2_FRAMES, (i, n) =>
        setStatus(`Zooming into downswing ${i}/${n}…`)
      );
      const detected2 = await detectAll(frames2, 'Analyzing impact');

      // Merge + sort by time
      const all = [...detected1, ...detected2].sort((a, b) => a.timeMs - b.timeMs);

      // ---- Phases + faults ----
      setStatus('Comparing against your ideal swing…');
      const labeled = labelPhases(all, ideal.profile.handedness);
      const analyzed = analyzeFrames(labeled, ideal);

      setResults(analyzed);
      setStatus('');
    } catch (e) {
      setStatus('Something went wrong: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // Live-capture path. Poses are already detected by the time we get here —
  // the frame processor did the work during recording — so all that's left is
  // labeling, scoring, and grabbing stills for the positions we display.
  async function handleCaptured(poses, videoUri) {
    setStep('analyze');
    setResults(null);
    setShowAll(false);
    if (poses.length < 4) {
      setStatus('Not enough of your body was visible. Film face-on with your whole body in frame.');
      return;
    }
    try {
      setBusy(true);
      setStatus('Comparing against your ideal swing…');
      const labeled = labelPhases(poses, ideal.profile.handedness);
      const analyzed = analyzeFrames(labeled, ideal);

      const shown = analyzed.filter(
        (f) => KEY_PHASES.includes(f.phase) || f.faults.length > 0
      );
      const uris = await extractFramesAt(
        videoUri,
        shown.map((f) => f.timeMs),
        (i, n) => setStatus(`Grabbing stills ${i}/${n}…`)
      );

      setResults(analyzed.map((f) => (uris[f.timeMs] ? { ...f, uri: uris[f.timeMs] } : f)));
      setStatus('');
    } catch (e) {
      setStatus('Something went wrong: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // Drives the real labelPhases → analyzeFrames path with hand-built poses.
  function runDemo() {
    setShowAll(false);
    setStatus('');
    const labeled = labelPhases(buildDemoSwing(), ideal.profile.handedness);
    setResults(analyzeFrames(labeled, ideal));
  }

  const totalFaults = results ? results.reduce((n, f) => n + f.faults.length, 0) : 0;
  const visibleFrames = results
    ? showAll
      ? results
      : results.filter((f) => KEY_PHASES.includes(f.phase) || f.faults.length > 0)
    : [];

  // Camera takes over the whole screen, so it renders instead of the scroller.
  if (step === 'camera' && ideal) {
    return (
      <SwingCamera
        onCaptured={handleCaptured}
        onCancel={(err) => {
          setStep('analyze');
          setStatus(err || '');
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.brand}>SWING COACH PRO</Text>
        <Text style={styles.tagline}>
          33-point body tracking. Your hypothetical best swing — built for your body.
        </Text>

        {step === 'profile' && (
          <View style={styles.panel}>
            <Text style={styles.section}>Your body</Text>
            <Field label="Height (cm)" value={String(profile.heightCm)} onChange={setNum('heightCm')} />
            <Field label="Weight (kg)" value={String(profile.weightKg)} onChange={setNum('weightKg')} />
            <Field label="Wingspan (cm) — leave as height if unsure" value={String(profile.wingspanCm)} onChange={setNum('wingspanCm')} />
            <Field label="Age" value={String(profile.age)} onChange={setNum('age')} />

            <Text style={styles.section}>Swing setup</Text>
            <Segment label="Handedness" options={['right', 'left']} value={profile.handedness} onChange={set('handedness')} />
            <Segment label="Flexibility" options={['low', 'average', 'high']} value={profile.flexibility} onChange={set('flexibility')} />
            <Segment label="Club in the video" options={['driver', 'iron', 'wedge']} value={profile.club} onChange={set('club')} />

            <Pressable style={styles.cta} onPress={lockProfile}>
              <Text style={styles.ctaText}>Build my ideal swing →</Text>
            </Pressable>
          </View>
        )}

        {step === 'analyze' && ideal && (
          <>
            <View style={styles.panel}>
              <Text style={styles.section}>Your personal ideal model</Text>
              {describeModel(ideal).map((line) => (
                <Text key={line} style={styles.modelLine}>• {line}</Text>
              ))}
              <Text style={styles.note}>
                Adjusted for {ideal.profile.heightCm} cm, {ideal.profile.weightKg} kg (BMI{' '}
                {ideal.bmi}), {ideal.profile.flexibility} flexibility, {ideal.profile.club}.
              </Text>
              <Pressable onPress={() => setStep('profile')}>
                <Text style={styles.link}>Edit profile</Text>
              </Pressable>
            </View>

            {/* Camera and video capture are native-only; the browser preview
                runs the analysis engine against a known synthetic swing. */}
            {Platform.OS !== 'web' && (
              <>
                <Pressable
                  style={[styles.cta, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={() => {
                    setStatus('');
                    setStep('camera');
                  }}
                >
                  <Text style={styles.ctaText}>Record a swing (live)</Text>
                </Pressable>

                <Pressable
                  style={[styles.ctaGhost, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={pickAndAnalyze}
                >
                  <Text style={styles.ctaGhostText}>
                    {results ? 'Analyze another video' : 'Pick a saved video'}
                  </Text>
                </Pressable>
              </>
            )}

            <Pressable
              style={[Platform.OS === 'web' ? styles.cta : styles.ctaGhost, busy && { opacity: 0.5 }]}
              disabled={busy}
              onPress={runDemo}
            >
              <Text style={Platform.OS === 'web' ? styles.ctaText : styles.ctaGhostText}>
                Run demo swing
              </Text>
            </Pressable>

            <Text style={styles.hint}>
              {Platform.OS === 'web'
                ? 'Browser preview: pose detection needs the native build, so the demo drives the real analysis engine with known poses.'
                : 'Live capture tracks you at full frame rate. Saved slow-mo clips (120/240fps) still give the sharpest impact frame.'}
            </Text>

            {busy && (
              <View style={styles.busy}>
                <ActivityIndicator color={CHALK} />
                <Text style={styles.busyText}>{status}</Text>
              </View>
            )}
            {!busy && status !== '' && <Text style={styles.error}>{status}</Text>}

            {results && (
              <>
                <View style={styles.scorecard}>
                  <Text style={styles.scoreBig}>
                    {totalFaults === 0 ? 'Pure.' : `${totalFaults} fix${totalFaults === 1 ? '' : 'es'} found`}
                  </Text>
                  <Text style={styles.scoreSub}>
                    Red = major · Amber = minor · Dashed circle = the section to change
                  </Text>
                </View>

                {visibleFrames.map((f, i) => (
                  <FrameOverlay key={f.timeMs + '-' + i} frame={f} displayWidth={width - 32} />
                ))}

                <Pressable onPress={() => setShowAll((s) => !s)}>
                  <Text style={[styles.link, { textAlign: 'center', marginBottom: 30 }]}>
                    {showAll
                      ? 'Show key positions only'
                      : `Show all ${results.length} frames`}
                  </Text>
                </Pressable>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType="numeric"
        placeholderTextColor={MOSS}
      />
    </View>
  );
}

function Segment({ label, options, value, onChange }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.segRow}>
        {options.map((o) => (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={[styles.seg, value === o && styles.segActive]}
          >
            <Text style={[styles.segText, value === o && styles.segTextActive]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: DEEP },
  scroll: { padding: 16, paddingBottom: 60 },
  brand: { color: CHALK, fontSize: 26, fontWeight: '900', letterSpacing: 5, marginTop: 8 },
  tagline: { color: MOSS, marginTop: 4, marginBottom: 18, lineHeight: 20 },
  panel: { backgroundColor: TURF, borderRadius: 14, padding: 16, marginBottom: 16 },
  section: {
    color: CHALK,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontSize: 13,
    marginBottom: 10,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  field: { marginBottom: 12 },
  fieldLabel: { color: MOSS, marginBottom: 6, fontSize: 13 },
  input: {
    backgroundColor: DEEP,
    color: CHALK,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  segRow: { flexDirection: 'row', gap: 8 },
  seg: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: DEEP, alignItems: 'center' },
  segActive: { backgroundColor: CHALK },
  segText: { color: MOSS, fontWeight: '600', textTransform: 'capitalize' },
  segTextActive: { color: DEEP },
  cta: { backgroundColor: FLAG, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 6 },
  ctaText: { color: CHALK, fontWeight: '800', fontSize: 16 },
  ctaGhost: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
    borderWidth: 1.5,
    borderColor: TURF,
  },
  ctaGhostText: { color: MOSS, fontWeight: '700', fontSize: 15 },
  hint: { color: MOSS, marginTop: 10, fontSize: 13, textAlign: 'center' },
  modelLine: { color: CHALK, lineHeight: 22 },
  note: { color: MOSS, marginTop: 8, fontSize: 13, lineHeight: 18 },
  link: { color: '#8FD6A5', marginTop: 10, fontWeight: '600' },
  busy: { alignItems: 'center', marginTop: 20 },
  busyText: { color: MOSS, marginTop: 10, textAlign: 'center' },
  error: { color: FLAG, marginTop: 14, textAlign: 'center' },
  scorecard: { marginTop: 22, marginBottom: 14 },
  scoreBig: { color: CHALK, fontSize: 24, fontWeight: '900' },
  scoreSub: { color: MOSS, marginTop: 4, fontSize: 13 },
});
