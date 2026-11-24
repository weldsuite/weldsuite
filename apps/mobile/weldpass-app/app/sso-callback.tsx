/**
 * Where the sign-in page sends the browser sheet back to
 * (`weldpass://sso-callback`, the redirect URI registered for the
 * `weldsuite-mobile` client on WeldID). The auth session picks the code up
 * from the sheet itself; this screen only shows while that finishes, then
 * AuthGuard moves on to the app.
 */

import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/lib/brand';

export default function SSOCallbackScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator size="large" color={BRAND} />
    </View>
  );
}
