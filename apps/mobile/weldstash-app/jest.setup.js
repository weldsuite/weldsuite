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
