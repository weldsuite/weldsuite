// Learn more about Jest setup: https://jestjs.io/docs/configuration

// Mock Expo modules
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {},
  },
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useSegments: jest.fn(),
  usePathname: jest.fn(),
  Stack: ({ children }) => children,
  Tabs: ({ children }) => children,
}));

jest.mock('expo-camera', () => ({
  Camera: jest.fn(),
  CameraView: jest.fn(),
}));

// Mock React Native modules
jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper');

// Mock React Native core
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return {
    ...RN,
    Alert: {
      alert: jest.fn(),
    },
  };
});

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}));

// Mock React Native Auth0
jest.mock('react-native-auth0', () => ({
  Auth0Provider: ({ children }) => children,
  useAuth0: jest.fn(),
}));

// Silence console warnings in tests
global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
