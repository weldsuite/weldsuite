// Stands in for @weldsuite/mobile-platform/api, which needs the booted server
// runtime. The host choice is tested in mobile-platform.
module.exports = {
  apiOrigin: jest.fn(() => 'http://localhost:8789'),
  apiOriginForPath: jest.fn(() => 'http://localhost:8789'),
};
