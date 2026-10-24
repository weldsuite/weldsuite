// Node-backed stand-in for `expo-crypto` (the real module needs the native
// Expo runtime, which the plain babel-jest setup here does not load).
const nodeCrypto = require('node:crypto');

module.exports = {
  getRandomBytes: (byteCount) => new Uint8Array(nodeCrypto.randomBytes(byteCount)),
};
