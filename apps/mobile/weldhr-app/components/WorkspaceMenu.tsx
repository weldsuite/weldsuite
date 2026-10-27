/**
 * The workspace at the top of Home, as in WeldChat: its logo and name. A tap
 * opens the native menu with the member's profile and settings, then the
 * workspaces to switch to, with a check on the current one.
 */

import { useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { ChevronDown } from 'lucide-react-native';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { BRAND } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useI18n } from '@/lib/i18n';

const PROFILE_ACTION = 'profile';
/** A workspace's action is this prefix plus its Clerk organization id. */
const WORKSPACE_ACTION = 'workspace:';

export function WorkspaceMenu() {
  const { t } = useI18n();
  const palette = usePalette();
  // The native menu sizes itself to what it wraps and does not shrink it, so
  // the button is held to the header's width (screen less its 16pt sides and
  // the 48pt slot on the right); a long name then shrinks, then truncates.
  const maxWidth = useWindowDimensions().width - 32 - 48;
  const router = useRouter();
  const { user } = useClerkAuth();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const [switching, setSwitching] = useState(false);

  const name = currentWorkspace?.name || t.home.workspaceFallback;
  const logo = currentWorkspace?.imageUrl;

  const switchTo = async (orgId: string) => {
    if (orgId === currentWorkspace?.clerkOrgId) return;
    setSwitching(true);
    try {
      await switchWorkspace(orgId);
    } catch {
      // WorkspaceContext logs it; the app stays on the current workspace.
    } finally {
      setSwitching(false);
    }
  };

  const actions: MenuAction[] = [
    {
      id: 'account',
      title: user?.email || user?.fullName || name,
      displayInline: true,
      subactions: [{ id: PROFILE_ACTION, title: t.home.profileAndSettings, image: 'gearshape' }],
    },
    {
      id: 'workspaces',
      title: t.home.switchWorkspace,
      displayInline: true,
      subactions: workspaces.map((workspace) => ({
        id: `${WORKSPACE_ACTION}${workspace.clerkOrgId}`,
        title: workspace.name,
        state: workspace.clerkOrgId === currentWorkspace?.clerkOrgId ? 'on' : 'off',
      })),
    },
  ];

  const onAction = (action: string) => {
    if (action === PROFILE_ACTION) router.push('/profile');
    else if (action.startsWith(WORKSPACE_ACTION)) void switchTo(action.slice(WORKSPACE_ACTION.length));
  };

  return (
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      style={[styles.menu, { maxWidth }]}
    >
      <View
        style={[styles.button, { maxWidth }]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${t.home.switchWorkspace}`}
        testID="home-workspace"
      >
        <View style={[styles.logo, { backgroundColor: BRAND }]}>
          {logo ? (
            <Image source={{ uri: logo }} style={StyleSheet.absoluteFill} />
          ) : (
            <Text style={styles.initial}>{name[0]?.toUpperCase()}</Text>
          )}
        </View>
        <Text style={[styles.name, { color: palette.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
          {name}
        </Text>
        {switching ? (
          <ActivityIndicator size="small" color={palette.muted} accessibilityLabel={t.home.switching} />
        ) : (
          <ChevronDown size={18} color={palette.muted} strokeWidth={2.2} />
        )}
      </View>
    </MenuView>
  );
}

const styles = StyleSheet.create({
  menu: { flexShrink: 1 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  logo: {
    width: 26,
    height: 26,
    borderRadius: 9,
    borderCurve: 'continuous',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  name: { flexShrink: 1, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
});
