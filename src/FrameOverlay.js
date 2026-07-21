// Renders one analyzed frame: the still image, the detected skeleton (chalk),
// wrong sections drawn in red, and a red circle around the faulty region.

import React from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import Svg, { Line, Circle } from 'react-native-svg';
import { EDGES, MIN_SCORE } from './pose';
import { resolvePoint } from './analysis';

const TURF = '#0E3B24';
const CHALK = '#F2EFE6';
const FLAG = '#E4353B';
const AMBER = '#E8A33D';

export default function FrameOverlay({ frame, displayWidth }) {
  const scale = displayWidth / frame.width;
  const h = frame.height * scale;
  const kp = frame.keypoints;

  // Collect fault edges as a set of "a|b" keys so we can color them red
  const faultEdgeKeys = new Set();
  const extraEdges = []; // virtual edges (spine line) not in the base skeleton
  const circles = [];

  for (const fault of frame.faults) {
    const color = fault.severity === 'major' ? FLAG : AMBER;
    for (const [a, b] of fault.edges) {
      const key = [a, b].sort().join('|');
      if (EDGES.some(([x, y]) => [x, y].sort().join('|') === key)) {
        faultEdgeKeys.add(key + '::' + color);
      } else {
        extraEdges.push({ a, b, color });
      }
    }
    // Circle around the wrong section: bounding circle over listed keypoints
    const pts = fault.circleAround
      .map((n) => resolvePoint(kp, n))
      .filter((p) => p && p.score >= MIN_SCORE);
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const r =
        Math.max(
          24 / scale,
          ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy) + 18 / scale)
        );
      circles.push({ cx, cy, r, color });
    }
  }

  return (
    <View style={[styles.card, { width: displayWidth }]}>
      <View style={styles.header}>
        <Text style={styles.phase}>{frame.phase.toUpperCase()}</Text>
        <Text style={styles.time}>{(frame.timeMs / 1000).toFixed(2)}s</Text>
      </View>

      <View style={{ width: displayWidth, height: h }}>
        {/* Live-captured frames only carry a still for the positions we show;
            the rest render skeleton-only on turf. */}
        {frame.uri ? (
          <Image
            source={{ uri: frame.uri }}
            style={{ width: displayWidth, height: h }}
            resizeMode="cover"
          />
        ) : (
          <View style={{ width: displayWidth, height: h, backgroundColor: '#061B10' }} />
        )}
        <Svg
          width={displayWidth}
          height={h}
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
        >
          {/* Base skeleton in chalk; faulty edges in red/amber */}
          {EDGES.map(([a, b], i) => {
            const pa = kp[a];
            const pb = kp[b];
            if (!pa || !pb || pa.score < MIN_SCORE || pb.score < MIN_SCORE)
              return null;
            const key = [a, b].sort().join('|');
            const faultMatch = [...faultEdgeKeys].find((k) =>
              k.startsWith(key + '::')
            );
            const stroke = faultMatch ? faultMatch.split('::')[1] : CHALK;
            return (
              <Line
                key={i}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={stroke}
                strokeWidth={faultMatch ? 6 : 3}
                strokeLinecap="round"
                opacity={faultMatch ? 1 : 0.85}
              />
            );
          })}

          {/* Virtual lines (e.g. spine hips_mid → shoulders_mid) */}
          {extraEdges.map((e, i) => {
            const pa = resolvePoint(kp, e.a);
            const pb = resolvePoint(kp, e.b);
            if (!pa || !pb) return null;
            return (
              <Line
                key={'x' + i}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={e.color}
                strokeWidth={6}
                strokeLinecap="round"
              />
            );
          })}

          {/* Joints */}
          {Object.entries(kp).map(([name, p]) =>
            p.score >= MIN_SCORE ? (
              <Circle key={name} cx={p.x} cy={p.y} r={5} fill={CHALK} />
            ) : null
          )}

          {/* Circles around wrong sections */}
          {circles.map((c, i) => (
            <Circle
              key={'c' + i}
              cx={c.cx}
              cy={c.cy}
              r={c.r}
              stroke={c.color}
              strokeWidth={5}
              fill="none"
              strokeDasharray="14 8"
            />
          ))}
        </Svg>
      </View>

      {/* Tips */}
      {frame.faults.length === 0 ? (
        <Text style={styles.good}>✓ On plan for your ideal model</Text>
      ) : (
        frame.faults.map((f) => (
          <View key={f.id} style={styles.tip}>
            <Text
              style={[
                styles.tipLabel,
                { color: f.severity === 'major' ? FLAG : AMBER },
              ]}
            >
              {f.severity === 'major' ? '⨯ ' : '△ '}
              {f.label}
            </Text>
            <Text style={styles.tipText}>Fix: {f.tip}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: TURF,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 18,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  phase: { color: CHALK, fontWeight: '800', letterSpacing: 2, fontSize: 12 },
  time: { color: '#9DBFA9', fontSize: 12 },
  good: { color: '#8FD6A5', padding: 12, fontWeight: '600' },
  tip: { paddingHorizontal: 12, paddingVertical: 8 },
  tipLabel: { fontWeight: '700', marginBottom: 2 },
  tipText: { color: CHALK, lineHeight: 19 },
});
