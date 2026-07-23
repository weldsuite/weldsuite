# WeldSuite Push Notifications

Complete push notification system with Firebase Cloud Messaging (FCM), SignalR real-time updates, and comprehensive user preference management.

## Features

✅ **FCM Push Notifications** - iOS and Android support with badge counts
✅ **Real-time Delivery** - SignalR for instant notifications when app is open
✅ **User Preferences** - Per-account settings, folder filtering, quiet hours
✅ **Notification History** - Track and display past notifications
✅ **Device Management** - Multiple device support with token validation
✅ **Security** - JWT authentication for SignalR, signature verification for webhooks

## Setup

### 1. Firebase Configuration

#### iOS Setup
1. Download `GoogleService-Info.plist` from Firebase Console
2. Place it in the iOS project root: `ios/GoogleService-Info.plist`

#### Android Setup
1. Download `google-services.json` from Firebase Console
2. Place it in the Android app directory: `android/app/google-services.json`

### 2. Environment Variables

Create `.env` file in `weldsuite-app` directory:

```bash
EXPO_PUBLIC_APP_API_URL=https://app-api.weldsuite.org
```

### 3. Build Configuration

The app is already configured with the following plugins in `app.json`:
- `expo-notifications` - Local and push notification handling
- `@react-native-firebase/app` - Firebase SDK integration

## Usage

### Request Permissions

Use the `NotificationProvider` context to request permissions:

```typescript
import { useNotifications } from '@/contexts/NotificationContext';

function MyComponent() {
  const { isPermissionGranted, requestPermissions } = useNotifications();

  useEffect(() => {
    if (!isPermissionGranted) {
      requestPermissions();
    }
  }, []);
}
```

### Access Notification State

```typescript
import { useNotifications } from '@/contexts/NotificationContext';

function MyComponent() {
  const { unreadCount, isConnected, isPermissionGranted } = useNotifications();

  return (
    <View>
      <Text>Unread: {unreadCount}</Text>
      <Text>SignalR: {isConnected ? 'Connected' : 'Disconnected'}</Text>
      <Text>Permissions: {isPermissionGranted ? 'Granted' : 'Not granted'}</Text>
    </View>
  );
}
```

### Send Test Notification

```typescript
import { sendTestNotification } from '@/services/notifications';
import { useAuth0 } from 'react-native-auth0';

function TestButton() {
  const { getCredentials } = useAuth0();

  const handleTest = async () => {
    const credentials = await getCredentials();
    if (credentials?.accessToken) {
      const success = await sendTestNotification(credentials.accessToken);
      console.log('Test notification sent:', success);
    }
  };

  return <Button onPress={handleTest} title="Send Test" />;
}
```

### Get Notification Preferences

```typescript
import api from '@/services/api';

async function loadPreferences(emailAccountId?: string) {
  const response = await api.getNotificationPreferences(emailAccountId);
  if (response.success) {
    console.log('Preferences:', response.data);
  }
}
```

### Update Preferences

```typescript
import api from '@/services/api';

async function savePreferences() {
  const preferences = {
    pushNotificationsEnabled: true,
    emailNotificationsEnabled: true,
    showPreview: true,
    playSound: true,
    vibrate: true,
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    importantOnly: false,
    disabledFolders: ['Spam', 'Promotions'],
    priority: 'default'
  };

  const response = await api.updateNotificationPreferences(preferences);
  if (response.success) {
    console.log('Preferences updated');
  }
}
```

## Backend API Endpoints

All endpoints are prefixed with `/api/mobile/notifications` and require JWT authentication.

### Device Registration

**POST** `/register-device`
```json
{
  "token": "FCM_DEVICE_TOKEN",
  "platform": "ios",
  "deviceModel": "iPhone 14 Pro",
  "osVersion": "iOS 17.2",
  "appVersion": "1.0.0"
}
```

**POST** `/unregister-device`
```json
{
  "token": "FCM_DEVICE_TOKEN"
}
```

### Preferences

**GET** `/preferences?emailAccountId=xxx`

**PUT** `/preferences`
```json
{
  "emailAccountId": "optional",
  "pushNotificationsEnabled": true,
  "showPreview": true,
  "playSound": true,
  "vibrate": true,
  "quietHoursStart": "22:00",
  "quietHoursEnd": "07:00",
  "quietHoursEnabled": true,
  "importantOnly": false,
  "disabledFolders": ["Spam"],
  "priority": "default"
}
```

### History & Testing

**GET** `/history?limit=50` - Get notification logs

**POST** `/test` - Send test notification

**POST** `/{notificationId}/read` - Mark as read

**GET** `/devices` - List user's registered devices

## SignalR Events

### Client-to-Server Methods

- `JoinUserGroup()` - Join personal notification group (auto-called on connect)
- `LeaveUserGroup()` - Leave personal notification group
- `SubscribeToEmailAccount(emailAccountId)` - Subscribe to account notifications
- `UnsubscribeFromEmailAccount(emailAccountId)` - Unsubscribe from account

### Server-to-Client Events

**ReceiveNewEmail**
```typescript
{
  type: 'new_email',
  emailId: 'xxx',
  emailAccountId: 'xxx',
  folder: 'INBOX',
  from: 'sender@example.com',
  fromName: 'Sender Name',
  subject: 'Email Subject',
  preview: 'Email preview text',
  isStarred: false,
  isRead: false,
  receivedAt: '2025-01-01T00:00:00Z',
  unreadCount: 5,
  title: 'New email from Sender Name',
  body: 'Email Subject'
}
```

**ReceiveBadgeUpdate**
```typescript
{
  unreadCount: 5
}
```

**ReceiveEmailReply**
```typescript
{
  type: 'email_reply',
  emailId: 'xxx',
  emailAccountId: 'xxx',
  // ... similar to ReceiveNewEmail
}
```

## Notification Routing

When a notification is tapped, the app automatically routes to the appropriate screen:

- New email notification → `/mail/{emailId}`
- Email account notification → `/mail`

This is handled automatically by the `NotificationProvider` in `contexts/NotificationContext.tsx`.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Mobile App (React Native)                │
├─────────────────────────────────────────────────────────────┤
│  NotificationProvider (Context)                              │
│  ├─ FCM Token Registration                                   │
│  ├─ SignalR Connection                                       │
│  ├─ Notification Listeners                                   │
│  └─ Badge Count Management                                   │
├─────────────────────────────────────────────────────────────┤
│  Services                                                     │
│  ├─ notifications.ts (FCM & Expo Notifications)             │
│  ├─ signalr.ts (Real-time connection)                       │
│  └─ api.ts (REST API client)                                │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend (.NET API)                        │
├─────────────────────────────────────────────────────────────┤
│  SignalR Hub (/hubs/notifications)                          │
│  ├─ JWT Authentication                                       │
│  ├─ User Group Management                                   │
│  └─ Real-time Event Broadcasting                            │
├─────────────────────────────────────────────────────────────┤
│  NotificationsController (/api/mobile/notifications)        │
│  ├─ Device Registration                                     │
│  ├─ Preference Management                                   │
│  ├─ History & Logs                                          │
│  └─ Test Notifications                                      │
├─────────────────────────────────────────────────────────────┤
│  EmailWebhooksController (/api/webhooks/email)              │
│  └─ AWS SES/SNS Webhook Handler                            │
├─────────────────────────────────────────────────────────────┤
│  Services                                                    │
│  ├─ NotificationService (Business Logic)                   │
│  ├─ FcmService (Firebase Admin SDK)                        │
│  └─ SignalRNotificationService (Hub Context)               │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    External Services                         │
├─────────────────────────────────────────────────────────────┤
│  Firebase Cloud Messaging                                    │
│  ├─ iOS APNS                                                │
│  └─ Android FCM                                             │
├─────────────────────────────────────────────────────────────┤
│  AWS SES (Email Receiving)                                  │
│  └─ SNS Webhooks → Backend                                  │
└─────────────────────────────────────────────────────────────┘
```

## Files

### Frontend (Mobile App)
- `contexts/NotificationContext.tsx` - React context provider
- `services/notifications.ts` - FCM & notification helpers
- `services/signalr.ts` - SignalR client service
- `services/api.ts` - API client with notification methods
- `app/_layout.tsx` - App layout with NotificationProvider

### Backend (API)
- `WeldSuite.Api.Unified/Hubs/NotificationHub.cs` - SignalR hub
- `WeldSuite.Api.Unified/Areas/Mobile/Controllers/NotificationsController.cs` - REST API
- `WeldSuite.Api.Unified/Areas/Webhooks/Controllers/EmailWebhooksController.cs` - Webhooks
- `WeldSuite.Services/Notifications/NotificationService.cs` - Business logic
- `WeldSuite.Services/Notifications/FcmService.cs` - Firebase integration
- `WeldSuite.Data/Entities/DeviceToken.cs` - Device token entity
- `WeldSuite.Data/Entities/NotificationPreference.cs` - User preferences
- `WeldSuite.Data/Entities/NotificationLog.cs` - Notification history

## Next Steps

1. **Create Notification Settings Screen** - UI for users to configure preferences
2. **Configure AWS SNS** - Set up email webhooks for new email notifications
3. **Add Firebase Credentials** - Upload Firebase config files for iOS and Android
4. **Test on Physical Devices** - Push notifications require real devices

## Troubleshooting

### FCM Token Issues
- Ensure Firebase config files are in the correct locations
- Check that `@react-native-firebase/app` plugin is in `app.json`
- Verify Firebase project settings match your app bundle IDs

### SignalR Connection Issues
- Check that `EXPO_PUBLIC_APP_API_URL` is set correctly
- Verify JWT token is being passed to SignalR connection
- Check API CORS settings allow SignalR connections

### No Notifications Received
- Verify permissions are granted
- Check device token is registered in database
- Verify notification preferences allow notifications
- Check quiet hours settings
- Review notification logs in database

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review backend logs for errors
3. Check FCM and SignalR connection status
4. Verify notification preferences in database
