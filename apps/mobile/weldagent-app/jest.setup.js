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

global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
