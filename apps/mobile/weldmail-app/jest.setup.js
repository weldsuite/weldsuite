// Global Jest setup for the WeldMail mobile app.
// Mocks the native/Expo modules that are pulled in transitively by the units
// under test, so importing app code does not blow up in the Node test runner.

// AsyncStorage — used by MailContext to persist the selected account.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
}));

// expo-constants — read in a few config helpers.
jest.mock('expo-constants', () => ({
  expoConfig: { extra: {} },
}));

// Silence the noisy RN/Expo dev warnings so test output stays readable.
// Individual tests can still spy on console if they need to assert on it.
global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
