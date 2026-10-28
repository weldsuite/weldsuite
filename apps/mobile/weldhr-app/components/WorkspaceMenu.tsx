/**
 * The workspace, in two places. At the top of Home, as in WeldChat, its logo
 * and name: a tap opens the profile. On the profile, the list of the member's
 * workspaces to switch between.
 */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { avatarColorFor, BRAND } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useI18n } from '@/lib/i18n';
import { Group, GroupRow, LetterTile, SelectedCheck } from './Grouped';

/** The workspace at the top of Home; a tap opens the profile. */
export function WorkspaceHeading() {
  const { t } = useI18n();
  const palette = usePalette();
  // Held to the header's width (screen less its 16pt sides and the 48pt slot
  // on the right); a long name then shrinks, then truncates.
  const maxWidth = useWindowDimensions().width - 32 - 48;
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();

  const name = currentWorkspace?.name || t.home.workspaceFallback;
  const logo = currentWorkspace?.imageUrl;

  return (
    <Pressable
      onPress={() => router.push('/profile')}
      style={({ pressed }) => [styles.button, { maxWidth }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${t.home.profileAndSettings}`}
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
      <ChevronRight size={20} color={palette.muted} strokeWidth={2.2} />
    </Pressable>
  );
}

/**
 * The member's workspaces on the profile, as Attio lists them: a letter on a
 * coloured tile and the name, a blue check on the current one; tapping
 * another switches to it.
 */
export function WorkspaceList() {
  const { t } = useI18n();
  const palette = usePalette();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const [switching, setSwitching] = useState<string | null>(null);

  const switchTo = async (orgId: string) => {
    if (orgId === currentWorkspace?.clerkOrgId || switching) return;
    setSwitching(orgId);
    try {
      await switchWorkspace(orgId);
    } catch {
      // WorkspaceContext logs it; the app stays on the current workspace.
    } finally {
      setSwitching(null);
    }
  };

  const list = workspaces.length > 0 ? workspaces : currentWorkspace ? [currentWorkspace] : [];
  return (
    <Group>
      {list.map((workspace) => {
        const current = workspace.clerkOrgId === currentWorkspace?.clerkOrgId;
        const name = workspace.name || t.home.workspaceFallback;
        let trailing: ReactNode = null;
        if (switching === workspace.clerkOrgId) {
          trailing = <ActivityIndicator size="small" color={palette.muted} accessibilityLabel={t.home.switching} />;
        } else if (current) trailing = <SelectedCheck />;
        return (
          <GroupRow
            key={workspace.clerkOrgId}
            leading={<LetterTile letter={name[0] ?? '?'} color={avatarColorFor(name)} />}
            title={name}
            value={trailing}
            onPress={() => void switchTo(workspace.clerkOrgId)}
            accessibilityRole="radio"
            selected={current}
            testID={`workspace-${workspace.clerkOrgId}`}
          />
        );
      })}
    </Group>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  pressed: { opacity: 0.6 },
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
