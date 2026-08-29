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

// expo-splash-screen — keep native splash mocked for Node tests.
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

// expo-observe — native metrics module; not available in Jest.
jest.mock('expo-observe', () => ({
  Observe: {
    configure: jest.fn(),
    markInteractive: jest.fn(),
  },
  ObserveRoot: {
    wrap: (Component) => Component,
  },
  useObserve: () => ({ markInteractive: jest.fn() }),
}));

// Silence the noisy RN/Expo dev warnings so test output stays readable.
// Individual tests can still spy on console if they need to assert on it.
global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
