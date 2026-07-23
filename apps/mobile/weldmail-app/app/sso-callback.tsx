/**
 * SSO Callback — handles the OAuth redirect from Clerk.
 * This screen is shown briefly while Clerk processes the auth session,
 * then AuthGuard redirects to the main app.
 */

import { View } from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';

export default function SSOCallbackScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <MaterialSpinner size={32} strokeWidth={3} color="#3B82F6" spinning />
    </View>
  );
}
