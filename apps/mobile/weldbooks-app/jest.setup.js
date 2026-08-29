// Global Jest setup for the WeldBooks mobile app.
// Mocks the native/Expo modules pulled in transitively by the units under test,
// so importing app code does not blow up in the Node test runner.

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-constants', () => ({
  expoConfig: { extra: {} },
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

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
