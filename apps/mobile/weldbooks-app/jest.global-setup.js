// Runs once in the Jest parent process, before any test file.
//
// The suite runs in US Pacific time unless TEST_TZ says otherwise. app-api
// stores accounting dates as midnight UTC, and anywhere west of UTC that is the
// evening of the day before when read in local time. That is where US users are,
// so it is the zone the date helpers have to be right in — and a fixed zone
// keeps the date tests the same on every machine and in CI. (TEST_TZ is for
// checking the other suites in another zone: date-timezone.test.ts needs one
// west of UTC and fails fast when it is not.)
module.exports = async () => {
  process.env.TZ = process.env.TEST_TZ || 'America/Los_Angeles';
};
