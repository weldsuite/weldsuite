/**
 * SSO Callback: the sign-in redirect target (`weldchat://sso-callback`), for
 * Clerk's SSO on WeldSuite cloud and the server's own sign-in (OIDC) on EU and
 * self-hosted servers. Shown briefly while the session is set up, then
 * AuthGuard redirects to the main app.
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
