// Stub for Expo's virtual env module (`expo/virtual/env`).
//
// babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*` reads through this
// module, which ships as untransformed ESM. Backing it with a live view of
// `process.env` fixes the transform and lets tests drive config by env var.
module.exports = {
  get env() {
    return process.env;
  },
};
