# Error Handling System

Comprehensive error handling utilities and components for the WeldSuite mobile app.

## Components

### ErrorBoundary

A React Error Boundary component that catches JavaScript errors anywhere in the child component tree.

**Usage:**

```tsx
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Basic usage
<ErrorBoundary>
  <YourComponent />
</ErrorBoundary>

// With custom fallback
<ErrorBoundary
  fallback={(error, reset) => (
    <CustomErrorScreen error={error} onRetry={reset} />
  )}
  onError={(error, errorInfo) => {
    // Log to error tracking service
    console.error('Error caught:', error, errorInfo);
  }}
>
  <YourComponent />
</ErrorBoundary>
```

**Features:**
- Catches and displays errors gracefully
- Provides "Try Again" button to reset error state
- Shows error details in development mode
- Customizable fallback UI
- Error logging hook for tracking services

## Utilities

### Error Parsing

```typescript
import { parseApiError } from '@/lib/errors/errorHandler';

try {
  const response = await api.getData();
} catch (error) {
  const appError = parseApiError(error);
  // Returns standardized AppError object
  console.log(appError.message, appError.code, appError.statusCode);
}
```

### Error Alerts

```typescript
import { showErrorAlert, showRetryAlert } from '@/lib/errors/errorHandler';

// Simple error alert
showErrorAlert(error, 'Failed to Load Data');

// Alert with retry option
showRetryAlert(
  error,
  () => loadData(), // Retry function
  'Failed to Load Data'
);
```

### Async Error Handling

```typescript
import { handleAsyncError } from '@/lib/errors/errorHandler';

const data = await handleAsyncError(
  () => api.getData(),
  {
    showAlert: true,
    alertTitle: 'Failed to Load Data',
    context: 'DataScreen',
    onError: (error) => {
      // Custom error handling
      console.log('Error occurred:', error);
    },
  }
);

if (data) {
  // Use data
}
```

### Retry with Backoff

```typescript
import { retryWithBackoff } from '@/lib/errors/errorHandler';

const data = await retryWithBackoff(
  () => api.getData(),
  3, // Max retries
  1000 // Initial delay in ms
);
```

### Error Type Checking

```typescript
import { isNetworkError, isAuthError } from '@/lib/errors/errorHandler';

try {
  await api.getData();
} catch (error) {
  if (isNetworkError(error)) {
    // Handle network error
  } else if (isAuthError(error)) {
    // Handle auth error - redirect to login
  }
}
```

### Error Logging

```typescript
import { logError } from '@/lib/errors/errorHandler';

try {
  // Your code
} catch (error) {
  logError(error, 'ComponentName');
  // Error is logged with timestamp and context
}
```

## Error Types

### AppError Interface

```typescript
interface AppError {
  message: string;      // User-friendly error message
  code?: string;        // Error code (e.g., 'NETWORK_ERROR', 'UNAUTHORIZED')
  statusCode?: number;  // HTTP status code
  details?: any;        // Additional error details
  timestamp: string;    // ISO timestamp
}
```

### HTTP Status Code Handling

The error handler automatically maps HTTP status codes to user-friendly messages:

- **400 (Bad Request)**: Invalid request
- **401 (Unauthorized)**: Authentication required
- **403 (Forbidden)**: Permission denied
- **404 (Not Found)**: Resource not found
- **409 (Conflict)**: Data conflict
- **422 (Validation Error)**: Validation failed
- **429 (Rate Limit)**: Too many requests
- **500 (Server Error)**: Server error
- **503 (Service Unavailable)**: Service unavailable

## Best Practices

### 1. Use ErrorBoundary at Module Level

```tsx
// In module layout file
<ErrorBoundary>
  <ModuleContent />
</ErrorBoundary>
```

### 2. Handle Async Errors with handleAsyncError

```tsx
const loadData = async () => {
  setLoading(true);

  const data = await handleAsyncError(
    () => api.getData(),
    { showAlert: true, context: 'MyScreen' }
  );

  setLoading(false);

  if (data) {
    setData(data);
  }
};
```

### 3. Use Retry for Flaky Operations

```tsx
const uploadData = async () => {
  try {
    await retryWithBackoff(
      () => api.uploadData(data),
      3, // 3 retries
      2000 // Start with 2s delay
    );
    showSuccess('Data uploaded');
  } catch (error) {
    showErrorAlert(parseApiError(error));
  }
};
```

### 4. Log All Errors

```tsx
try {
  // Your code
} catch (error) {
  logError(error, 'MyComponent');
  // Error is logged for debugging
  showErrorAlert(parseApiError(error));
}
```

### 5. Handle Network Errors Gracefully

```tsx
try {
  await api.getData();
} catch (error) {
  if (isNetworkError(error)) {
    showRetryAlert(error, () => loadData());
  } else {
    showErrorAlert(error);
  }
}
```

## Integration with Error Tracking Services

To integrate with services like Sentry:

1. Install Sentry:
```bash
pnpm add @sentry/react-native
```

2. Update `errorHandler.ts`:
```typescript
import * as Sentry from '@sentry/react-native';

export function logError(error: any, context?: string) {
  console.error(error);

  // Send to Sentry
  Sentry.captureException(error, {
    tags: { context },
    level: 'error',
  });
}
```

3. Update `ErrorBoundary.tsx`:
```typescript
componentDidCatch(error: Error, errorInfo: ErrorInfo) {
  console.error('ErrorBoundary caught:', error, errorInfo);

  // Send to Sentry
  Sentry.captureException(error, {
    contexts: {
      react: {
        componentStack: errorInfo.componentStack,
      },
    },
  });
}
```

## Examples

### Complete Screen with Error Handling

```tsx
import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { handleAsyncError, showErrorAlert } from '@/lib/errors/errorHandler';
import api from '@/services/api';

function DataScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);

    const result = await handleAsyncError(
      () => api.getData(),
      {
        showAlert: true,
        alertTitle: 'Failed to Load Data',
        context: 'DataScreen',
      }
    );

    setLoading(false);

    if (result) {
      setData(result);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return <ActivityIndicator />;
  }

  return (
    <View>
      <Text>{data?.title}</Text>
    </View>
  );
}

export default function DataScreenWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <DataScreen />
    </ErrorBoundary>
  );
}
```

## Testing

To test error handling:

1. **Test ErrorBoundary**:
```tsx
// Throw error in component
throw new Error('Test error');
```

2. **Test Network Errors**:
```tsx
// Turn off network in device/simulator
await api.getData(); // Will show network error
```

3. **Test Auth Errors**:
```tsx
// Clear auth token
await api.getData(); // Will show 401 error
```

## Future Enhancements

- [ ] Add error tracking service integration (Sentry, Bugsnag)
- [ ] Implement offline error queue
- [ ] Add error recovery strategies
- [ ] Create error analytics dashboard
- [ ] Add user feedback collection on errors
