// Web build of SwingCamera.js. VisionCamera frame processors are native-only,
// so this stands in for the live capture screen and explains why.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

const DEEP = '#082516';
const CHALK = '#F2EFE6';
const MOSS = '#9DBFA9';

export default function SwingCamera({ onCancel }) {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Live capture is native-only</Text>
      <Text style={styles.body}>
        The frame processor runs BlazePose on the camera buffer through VisionCamera and
        react-native-fast-tflite. Neither exists in a browser, so this screen is a stub on web.
      </Text>
      <Text style={styles.body}>
        Run the demo swing instead — it drives the real analysis engine with known poses.
      </Text>
      <Pressable onPress={() => onCancel()}>
        <Text style={styles.link}>← Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: DEEP, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { color: CHALK, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  body: { color: MOSS, textAlign: 'center', lineHeight: 21, marginBottom: 14, maxWidth: 460 },
  link: { color: '#8FD6A5', fontWeight: '700', marginTop: 10, fontSize: 16 },
});
