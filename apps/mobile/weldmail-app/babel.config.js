module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
    env: {
      // Strip all console.* calls from production builds so email bodies,
      // recipients, tokens and full error objects never reach device logs.
      // (Dev builds keep them; jest uses configFile:false so it's unaffected.)
      production: {
        plugins: ['transform-remove-console'],
      },
    },
  };
};
