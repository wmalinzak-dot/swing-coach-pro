// Web build of videoFrames.js. expo-video-thumbnails has no browser
// implementation, so frame extraction is unavailable here.

const unavailable = () => {
  throw new Error('Video frame extraction needs the native build.');
};

export const extractFrames = unavailable;
export const extractFramesAt = unavailable;
export const densifyDownswing = unavailable;
