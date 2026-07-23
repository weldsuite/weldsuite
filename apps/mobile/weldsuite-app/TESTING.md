# Testing Guide

Testing infrastructure and guidelines for the WeldSuite mobile app.

## Test Setup

### Prerequisites

The app uses Jest as the test framework with React Native Testing Library for component testing.

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage

# Run specific test file
pnpm test errorHandler.test.ts
```

## Test Structure

### Directory Organization

```
apps/mobile/weldsuite-app/
├── __tests__/              # Integration tests
├── components/
│   └── __tests__/          # Component tests
├── lib/
│   └── errors/
│       └── __tests__/      # Error handling tests
├── utils/
│   └── __tests__/          # Utility function tests
└── services/
    └── __tests__/          # API service tests
```

## Test Categories

### 1. Unit Tests

Test individual functions and utilities in isolation.

**Example: Testing utility functions**

```typescript
// utils/__tests__/formatters.test.ts
import { formatDate, formatMoney } from '../formatters';

describe('formatters', () => {
  describe('formatDate', () => {
    it('should format ISO date string', () => {
      const date = '2024-01-15T10:30:00Z';
      const result = formatDate(date);
      expect(result).toContain('Jan 15');
    });

    it('should handle null values', () => {
      expect(formatDate(null)).toBe('');
    });
  });

  describe('formatMoney', () => {
    it('should format USD currency', () => {
      expect(formatMoney(1234.56, 'USD')).toBe('$1,234.56');
    });
  });
});
```

### 2. Component Tests

Test React components with React Native Testing Library.

**Example: Testing a component**

```typescript
// components/__tests__/ErrorBoundary.test.tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { ErrorBoundary } from '../ErrorBoundary';

const ThrowError = () => {
  throw new Error('Test error');
};

describe('ErrorBoundary', () => {
  it('should catch and display errors', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>
    );

    expect(getByText(/Something went wrong/i)).toBeDefined();
    expect(getByText(/Test error/i)).toBeDefined();
  });

  it('should render children when no error', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Text>Content</Text>
      </ErrorBoundary>
    );

    expect(getByText('Content')).toBeDefined();
  });
});
```

### 3. Integration Tests

Test interactions between multiple components or services.

**Example: Testing API integration**

```typescript
// services/__tests__/api.integration.test.ts
import api from '../api';

describe('API Integration', () => {
  beforeEach(() => {
    // Setup mock server or use real test API
  });

  it('should fetch pick lists successfully', async () => {
    const result = await api.getPickLists();

    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Array);
  });

  it('should handle errors gracefully', async () => {
    // Mock failed request
    const result = await api.getPickLists();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

### 4. Snapshot Tests

Capture component output for regression testing.

```typescript
import React from 'react';
import renderer from 'react-test-renderer';
import { MetricCard } from '../MetricCard';

describe('MetricCard', () => {
  it('should match snapshot', () => {
    const tree = renderer.create(
      <MetricCard
        title="Total Orders"
        value="123"
        change={5.2}
        icon="shopping-cart"
      />
    ).toJSON();

    expect(tree).toMatchSnapshot();
  });
});
```

## Testing Patterns

### Mocking API Calls

```typescript
import api from '@/services/api';

jest.mock('@/services/api', () => ({
  getPickLists: jest.fn(),
  getPickList: jest.fn(),
  startPickList: jest.fn(),
}));

describe('PickList Component', () => {
  it('should load pick lists on mount', async () => {
    const mockData = [{ id: '1', pickListNumber: 'PL-001' }];
    (api.getPickLists as jest.Mock).mockResolvedValue({
      success: true,
      data: mockData,
    });

    // Test component
  });
});
```

### Testing Async Operations

```typescript
import { waitFor } from '@testing-library/react-native';

it('should load data asynchronously', async () => {
  const { getByText } = render(<DataScreen />);

  await waitFor(() => {
    expect(getByText('Data loaded')).toBeDefined();
  });
});
```

### Testing User Interactions

```typescript
import { fireEvent } from '@testing-library/react-native';

it('should handle button press', () => {
  const onPress = jest.fn();
  const { getByText } = render(
    <Button onPress={onPress}>Click Me</Button>
  );

  fireEvent.press(getByText('Click Me'));

  expect(onPress).toHaveBeenCalledTimes(1);
});
```

### Testing Hooks

```typescript
import { renderHook, act } from '@testing-library/react-hooks';
import { useTheme } from '../ThemeContext';

describe('useTheme', () => {
  it('should toggle theme', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe('dark');
  });
});
```

## Test Coverage

### Current Coverage

```
File                   | % Stmts | % Branch | % Funcs | % Lines |
-----------------------|---------|----------|---------|---------|
lib/errors/            |   85.2  |   78.5   |   90.0  |   84.8  |
 errorHandler.ts       |   85.2  |   78.5   |   90.0  |   84.8  |
utils/                 |   72.5  |   65.0   |   80.0  |   71.9  |
 wms-helpers.ts        |   72.5  |   65.0   |   80.0  |   71.9  |
-----------------------|---------|----------|---------|---------|
All files              |   78.3  |   71.2   |   85.0  |   77.8  |
```

### Coverage Goals

- **Statements**: 80%+
- **Branches**: 70%+
- **Functions**: 80%+
- **Lines**: 80%+

### Viewing Coverage

```bash
pnpm test:coverage
# Opens coverage report in browser
open coverage/lcov-report/index.html
```

## Testing Best Practices

### 1. Follow AAA Pattern

```typescript
it('should update status', () => {
  // Arrange
  const initialStatus = 'pending';

  // Act
  const newStatus = updateStatus(initialStatus);

  // Assert
  expect(newStatus).toBe('in_progress');
});
```

### 2. Test Edge Cases

```typescript
describe('formatMoney', () => {
  it('should handle zero', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });

  it('should handle negative amounts', () => {
    expect(formatMoney(-100, 'USD')).toBe('-$100.00');
  });

  it('should handle very large numbers', () => {
    expect(formatMoney(9999999.99, 'USD')).toBe('$9,999,999.99');
  });
});
```

### 3. Keep Tests Independent

```typescript
// Bad - tests depend on each other
let counter = 0;

it('should increment counter', () => {
  counter++;
  expect(counter).toBe(1);
});

it('should increment again', () => {
  counter++;
  expect(counter).toBe(2); // Fails if previous test doesn't run
});

// Good - tests are independent
it('should increment counter', () => {
  let counter = 0;
  counter++;
  expect(counter).toBe(1);
});

it('should increment again', () => {
  let counter = 0;
  counter++;
  expect(counter).toBe(1);
});
```

### 4. Use Descriptive Test Names

```typescript
// Bad
it('works', () => {});

// Good
it('should return user data when API call succeeds', () => {});
```

### 5. Mock External Dependencies

```typescript
// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

// Mock navigation
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
  }),
}));
```

## Continuous Integration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install

      - name: Run tests
        run: pnpm test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
```

## Debugging Tests

### Run Single Test

```bash
# Run single test file
pnpm test errorHandler.test.ts

# Run single test case
pnpm test -t "should parse network errors"
```

### Debug Mode

```bash
# Run tests in debug mode
node --inspect-brk node_modules/.bin/jest --runInBand

# In Chrome: chrome://inspect
```

### Verbose Output

```bash
pnpm test --verbose
```

## Next Steps

### Testing Roadmap

- [ ] Add E2E tests with Detox
- [ ] Set up visual regression testing
- [ ] Implement performance testing
- [ ] Add accessibility testing
- [ ] Create test data factories
- [ ] Set up mutation testing
- [ ] Add contract testing for API
- [ ] Implement load testing

### E2E Testing (Future)

```bash
# Install Detox
pnpm add -D detox

# Run E2E tests
pnpm detox build
pnpm detox test
```

### Performance Testing (Future)

```typescript
import { measure } from '@testing-library/react-native';

it('should render large list efficiently', async () => {
  const { timing } = await measure(
    <LargeList items={largeDataset} />
  );

  expect(timing.render).toBeLessThan(100); // ms
});
```

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [React Native Testing Library](https://callstack.github.io/react-native-testing-library/)
- [Testing React Native Apps](https://reactnative.dev/docs/testing-overview)
- [Detox E2E Testing](https://wix.github.io/Detox/)
