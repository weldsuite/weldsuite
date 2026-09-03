/**
 * SSO Callback — handles the OAuth redirect from Clerk.
 * This screen is shown briefly while Clerk processes the auth session,
 * then AuthGuard redirects to the main app.
 */

import { View, ActivityIndicator } from 'react-native';

import { BRAND } from '@/lib/brand';

export default function SSOCallbackScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color={BRAND} />
    </View>
  );
}
