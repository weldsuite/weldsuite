# WebSocket Notifications

Real-time notification system for WeldSuite Platform using AWS WebSocket API Gateway.

## Overview

The notification system connects to a WebSocket server at `wss://jbtuci4g58.execute-api.eu-central-1.amazonaws.com` and provides real-time notifications throughout the platform app. It includes automatic reconnection, token refresh, and type-safe message handling.

## Architecture

- **WebSocket Client**: Low-level client that manages connection, reconnection, and message handling
- **Notification Provider**: React context provider that wraps the app and manages client lifecycle
- **Custom Hooks**: Type-safe hooks for consuming notifications in components

## Setup

The notification system is already integrated into the root layout. No additional setup is required.

## Usage

### 1. Subscribe to All Notifications

```tsx
import { useNotificationSubscription } from '@/lib/notifications';

function MyComponent() {
  useNotificationSubscription((notification) => {
    console.log('Received:', notification.type, notification.message);
  });

  return <div>Listening for notifications...</div>;
}
```

### 2. Subscribe to Specific Notification Type

```tsx
import { useNotificationType } from '@/lib/notifications';

function OrdersComponent() {
  useNotificationType('order_created', (notification) => {
    console.log('New order:', notification.data);
    // Refresh orders list, show toast, etc.
  });

  return <div>Orders</div>;
}
```

### 3. Subscribe to Multiple Types

```tsx
import { useNotificationTypes } from '@/lib/notifications';

function Dashboard() {
  useNotificationTypes(
    ['order_created', 'order_updated', 'invoice_ready'],
    (notification) => {
      console.log('Order/Invoice update:', notification);
    }
  );

  return <div>Dashboard</div>;
}
```

### 4. Check Connection Status

```tsx
import { useNotificationStatus } from '@/lib/notifications';

function StatusIndicator() {
  const status = useNotificationStatus();

  return (
    <div>
      Connection: {status}
      {status === 'connected' && <span className="text-green-500">●</span>}
      {status === 'disconnected' && <span className="text-red-500">●</span>}
      {status === 'connecting' && <span className="text-yellow-500">●</span>}
    </div>
  );
}
```

### 5. Track Unread Notifications

```tsx
import { useUnreadNotifications } from '@/lib/notifications';

function NotificationBell() {
  const { unreadCount, unreadNotifications, markAsRead, markAllAsRead } =
    useUnreadNotifications();

  return (
    <div>
      <button onClick={markAllAsRead}>
        🔔 {unreadCount > 0 && <span>({unreadCount})</span>}
      </button>

      {unreadNotifications.map((notification) => (
        <div key={notification.timestamp}>
          {notification.message}
          <button onClick={() => markAsRead(notification.timestamp)}>
            Mark read
          </button>
        </div>
      ))}
    </div>
  );
}
```

### 6. View Notification History

```tsx
import { useNotificationHistory } from '@/lib/notifications';

function NotificationHistory() {
  const notifications = useNotificationHistory();

  return (
    <div>
      <h2>Recent Notifications</h2>
      {notifications.map((notification) => (
        <div key={notification.timestamp}>
          <strong>{notification.type}</strong>: {notification.message}
          <small>{new Date(notification.timestamp).toLocaleString()}</small>
        </div>
      ))}
    </div>
  );
}
```

### 7. Show Toast Notifications

```tsx
import { useNotificationType } from '@/lib/notifications';
import { toast } from 'sonner';

function ToastNotifications() {
  // Show toast for specific notification types
  useNotificationType('order_created', (notification) => {
    toast.success(notification.message, {
      description: `Order ID: ${notification.data?.orderId}`,
    });
  });

  useNotificationType('system_alert', (notification) => {
    toast.error(notification.message, {
      duration: 10000,
    });
  });

  return null; // This component doesn't render anything
}
```

### 8. Execute Actions on Notifications

```tsx
import { useNotificationAction } from '@/lib/notifications';
import { useRouter } from 'next/navigation';

function NavigationHandler() {
  const router = useRouter();

  useNotificationAction('task_assigned', (notification) => {
    // Navigate to task when assigned
    if (notification.data?.taskId) {
      router.push(`/task/${notification.data.taskId}`);
    }
  });

  return null;
}
```

### 9. Advanced: Direct Context Access

```tsx
import { useNotifications } from '@/lib/notifications';

function AdvancedComponent() {
  const { status, notifications, subscribe, subscribeToType, clearNotifications } =
    useNotifications();

  const handleClear = () => {
    clearNotifications();
  };

  return (
    <div>
      <p>Status: {status}</p>
      <p>Total notifications: {notifications.length}</p>
      <button onClick={handleClear}>Clear All</button>
    </div>
  );
}
```

## Notification Message Structure

All notifications follow this structure:

```typescript
interface NotificationMessage<T = any> {
  type: string; // Notification type (e.g., 'order_created')
  message: string; // Human-readable message
  data?: T; // Optional typed data payload
  timestamp: string; // ISO 8601 timestamp
}
```

### Example Notification

```json
{
  "type": "order_created",
  "message": "Order #12345 has been created",
  "data": {
    "orderId": 12345,
    "orderNumber": "ORD-12345",
    "amount": 99.99
  },
  "timestamp": "2025-11-10T16:46:36.848Z"
}
```

## Common Notification Types

| Type                 | Description                   |
| -------------------- | ----------------------------- |
| `order_created`      | New order created             |
| `order_updated`      | Order status changed          |
| `invoice_ready`      | Invoice generated             |
| `payment_received`   | Payment processed             |
| `product_added`      | New product in catalog        |
| `system_announcement`| Platform-wide announcement    |
| `system_alert`       | Important system alert        |
| `profile_updated`    | User profile changed          |
| `task_assigned`      | Task assigned to user         |
| `task_completed`     | Task marked complete          |
| `meeting_reminder`   | Upcoming meeting reminder     |
| `message_received`   | New message received          |

## Best Practices

### 1. Use Typed Notifications

```typescript
interface OrderCreatedData {
  orderId: number;
  orderNumber: string;
  amount: number;
}

useNotificationType<OrderCreatedData>('order_created', (notification) => {
  // notification.data is now typed as OrderCreatedData
  console.log(notification.data.orderId);
});
```

### 2. Avoid Memory Leaks

All hooks automatically clean up subscriptions when the component unmounts. No manual cleanup needed!

### 3. Keep Handlers Light

```tsx
// ❌ Bad: Heavy computation in handler
useNotificationType('order_created', (notification) => {
  performExpensiveCalculation();
  updateMultipleStates();
});

// ✅ Good: Dispatch action or set state
useNotificationType('order_created', (notification) => {
  setNewOrder(notification.data);
});
```

### 4. Use Multiple Specific Subscriptions Over One Generic

```tsx
// ❌ Less optimal
useNotificationSubscription((notification) => {
  if (notification.type === 'order_created') {
    handleOrderCreated(notification);
  } else if (notification.type === 'invoice_ready') {
    handleInvoiceReady(notification);
  }
});

// ✅ Better
useNotificationType('order_created', handleOrderCreated);
useNotificationType('invoice_ready', handleInvoiceReady);
```

## Connection Management

The notification system handles connection management automatically:

- **Auto-connect**: Connects automatically when user is authenticated
- **Auto-reconnect**: Reconnects with exponential backoff (up to 10 attempts)
- **Token refresh**: Refreshes Auth0 token every 55 minutes
- **Heartbeat**: Sends ping every 30 seconds to keep connection alive
- **Cleanup**: Disconnects and cleans up when user logs out

## Troubleshooting

### Notifications Not Received

1. Check connection status with `useNotificationStatus()`
2. Verify Auth0 token is valid
3. Check browser console for WebSocket errors
4. Verify backend Lambda is running

### Connection Keeps Disconnecting

1. Check if Auth0 token is expiring
2. Verify network connectivity
3. Check CloudWatch logs for backend errors

### TypeScript Errors

Make sure to import types from `@/lib/notifications`:

```typescript
import type { NotificationMessage, ConnectionStatus } from '@/lib/notifications';
```

## Testing

You can test the notification system using the test client:

1. Open `E:\Repos\WeldSuite.Backend\infrastructure\WebSocketNotifications\test-client.html`
2. Enter the WebSocket URL and your Auth0 token
3. Connect and send test notifications

Or use the bash script:

```bash
./test-send-user-notification.sh \
  "https://function-url.lambda-url.region.on.aws/" \
  "your-user-id" \
  "Test message" \
  "test"
```

## Related Files

- `lib/notifications/types.ts` - TypeScript type definitions
- `lib/notifications/websocket-client.ts` - WebSocket client implementation
- `contexts/notification-context.tsx` - React context provider
- `hooks/use-notification-subscription.ts` - Custom hooks
- `app/api/auth/token/route.ts` - Token endpoint for WebSocket auth
