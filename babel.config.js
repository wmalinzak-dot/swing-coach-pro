// react-native-worklets-core needs its babel plugin to compile every function
// marked 'worklet' (see src/poseWorklet.js and the frame processor in
// src/useSwingCapture.js). Without this the frame processor silently no-ops.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets-core/plugin'],
  };
};
