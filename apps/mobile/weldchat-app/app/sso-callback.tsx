/**
 * Where the sign-in page sends the browser sheet back to
 * (`weldchat://sso-callback`, the redirect URI registered for the
 * `weldsuite-mobile` client on WeldID). The auth session picks the code up
 * from the sheet itself; this screen only shows while that finishes, then
 * AuthGuard moves on to the app.
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
