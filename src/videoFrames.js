// Dense frame extraction: samples the whole clip, then re-samples the
// downswing at double density so we don't miss impact (the downswing is
// ~4× faster than the backswing).

import * as VideoThumbnails from 'expo-video-thumbnails';

export async function extractFrames(videoUri, durationMs, count, onProgress) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = Math.round((durationMs * i) / (count - 1));
    onProgress && onProgress(i + 1, count);
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: Math.min(t, Math.max(0, durationMs - 40)),
        quality: 0.85,
      });
      frames.push({ uri: thumb.uri, width: thumb.width, height: thumb.height, timeMs: t });
    } catch (e) {
      // unreadable frame — skip
    }
  }
  return frames;
}

// Live-capture path: poses are already detected on the frame-processor thread,
// so we only seek the recorded video for the handful of frames we actually
// display. Returns a map of timeMs → thumbnail uri.
export async function extractFramesAt(videoUri, timesMs, onProgress) {
  const byTime = {};
  for (let i = 0; i < timesMs.length; i++) {
    onProgress && onProgress(i + 1, timesMs.length);
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: Math.max(0, timesMs[i]),
        quality: 0.85,
      });
      byTime[timesMs[i]] = thumb.uri;
    } catch (e) {
      // unreadable frame — the overlay falls back to skeleton-only
    }
  }
  return byTime;
}

// After the top of the swing is known, pull extra frames between top and
// ~40% into the follow-through window to nail the impact position.
export async function densifyDownswing(videoUri, topMs, endMs, extra, onProgress) {
  const frames = [];
  const windowEnd = topMs + (endMs - topMs) * 0.5;
  for (let i = 1; i <= extra; i++) {
    const t = Math.round(topMs + ((windowEnd - topMs) * i) / (extra + 1));
    onProgress && onProgress(i, extra);
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: t,
        quality: 0.85,
      });
      frames.push({ uri: thumb.uri, width: thumb.width, height: thumb.height, timeMs: t });
    } catch (e) {}
  }
  return frames;
}
