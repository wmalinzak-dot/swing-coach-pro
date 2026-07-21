// Live capture screen: camera preview, real-time skeleton, record button.
//
// Recording and pose collection run together — the frame processor builds the
// pose track while VisionCamera writes the video file. When the user stops we
// hand both back so App.js can pull stills for just the key frames.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import Svg, { Line, Circle } from 'react-native-svg';

import { useSwingCapture } from './useSwingCapture';
import { EDGES, MIN_SCORE } from './constants';

const DEEP = '#082516';
const CHALK = '#F2EFE6';
const FLAG = '#E4353B';
const MOSS = '#9DBFA9';

export default function SwingCamera({ onCaptured, onCancel }) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const camera = useRef(null);
  const [recording, setRecording] = useState(false);

  const {
    frameProcessor,
    liveKeypoints,
    startCollecting,
    stopCollecting,
    modelState,
    modelError,
  } = useSwingCapture();

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  async function start() {
    if (!camera.current) return;
    startCollecting();
    setRecording(true);
    camera.current.startRecording({
      onRecordingFinished: (video) => {
        const poses = stopCollecting();
        setRecording(false);
        onCaptured(poses, video.path.startsWith('file://') ? video.path : 'file://' + video.path);
      },
      onRecordingError: (e) => {
        stopCollecting();
        setRecording(false);
        onCancel('Recording failed: ' + e.message);
      },
    });
  }

  async function stop() {
    if (camera.current && recording) await camera.current.stopRecording();
  }

  if (!hasPermission) {
    return (
      <Centered>
        <Text style={styles.msg}>Swing Coach needs camera access to film your swing.</Text>
        <Pressable style={styles.cta} onPress={requestPermission}>
          <Text style={styles.ctaText}>Grant access</Text>
        </Pressable>
        <Pressable onPress={() => onCancel()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </Centered>
    );
  }

  if (device == null) {
    return (
      <Centered>
        <Text style={styles.msg}>No camera found on this device.</Text>
        <Pressable onPress={() => onCancel()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </Centered>
    );
  }

  if (modelState === 'error') {
    return (
      <Centered>
        <Text style={styles.msg}>
          Could not load BlazePose: {modelError?.message ?? 'unknown error'}
        </Text>
        <Text style={styles.hint}>Did you run `npm run get-model`?</Text>
        <Pressable onPress={() => onCancel()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </Centered>
    );
  }

  return (
    <View style={styles.root}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        video={true}
        // yuv is the cheapest format to hand to a frame processor; the resize
        // plugin converts to rgb natively.
        pixelFormat="yuv"
        frameProcessor={modelState === 'loaded' ? frameProcessor : undefined}
      />

      {liveKeypoints && <LiveSkeleton {...liveKeypoints} />}

      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {modelState !== 'loaded'
            ? 'Loading BlazePose…'
            : recording
              ? 'Recording — make your swing'
              : 'Face-on, whole body in frame'}
        </Text>
      </View>

      <View style={styles.controls}>
        <Pressable onPress={() => onCancel()} disabled={recording}>
          <Text style={[styles.link, recording && { opacity: 0.3 }]}>Cancel</Text>
        </Pressable>

        <Pressable
          onPress={recording ? stop : start}
          disabled={modelState !== 'loaded'}
          style={[
            styles.shutter,
            recording && styles.shutterActive,
            modelState !== 'loaded' && { opacity: 0.4 },
          ]}
        >
          {modelState !== 'loaded' && <ActivityIndicator color={CHALK} />}
        </Pressable>

        <View style={{ width: 60 }} />
      </View>
    </View>
  );
}

// Skeleton drawn over the live preview so the user can see tracking is locked
// on before they swing.
function LiveSkeleton({ keypoints, width, height }) {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${width} ${height}`} pointerEvents="none">
      {EDGES.map(([a, b], i) => {
        const pa = keypoints[a];
        const pb = keypoints[b];
        if (!pa || !pb || pa.score < MIN_SCORE || pb.score < MIN_SCORE) return null;
        return (
          <Line
            key={i}
            x1={pa.x}
            y1={pa.y}
            x2={pb.x}
            y2={pb.y}
            stroke={CHALK}
            strokeWidth={4}
            strokeLinecap="round"
            opacity={0.9}
          />
        );
      })}
      {Object.keys(keypoints).map((name) =>
        keypoints[name].score >= MIN_SCORE ? (
          <Circle key={name} cx={keypoints[name].x} cy={keypoints[name].y} r={5} fill={CHALK} />
        ) : null
      )}
    </Svg>
  );
}

function Centered({ children }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, backgroundColor: DEEP, alignItems: 'center', justifyContent: 'center', padding: 28 },
  msg: { color: CHALK, textAlign: 'center', fontSize: 16, lineHeight: 23, marginBottom: 18 },
  hint: { color: MOSS, textAlign: 'center', fontSize: 13, marginBottom: 18 },
  hud: { position: 'absolute', top: 60, left: 0, right: 0, alignItems: 'center' },
  hudText: {
    color: CHALK,
    backgroundColor: 'rgba(8,37,22,0.75)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    overflow: 'hidden',
    fontSize: 13,
    fontWeight: '600',
  },
  controls: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: FLAG,
    borderWidth: 5,
    borderColor: CHALK,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterActive: { backgroundColor: CHALK, borderColor: FLAG, borderRadius: 14 },
  cta: { backgroundColor: FLAG, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 26 },
  ctaText: { color: CHALK, fontWeight: '800', fontSize: 16 },
  link: { color: '#8FD6A5', marginTop: 14, fontWeight: '600', width: 60 },
});
