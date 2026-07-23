// Stub for Expo's virtual env module (`expo/virtual/env`).
//
// babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*` reads to go through
// this module. The real file ships as untransformed ESM in node_modules, so we
// stub it with a live view of `process.env` — this both fixes the transform and
// lets tests drive config by mutating env vars before requiring app code.
module.exports = {
  get env() {
    return process.env;
  },
};
