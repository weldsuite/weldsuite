/**
 * The round "+" floating above the tab bar on every tab, with the menu behind
 * it (AddSheet). The tab layout renders it once, so it stays put while the
 * tabs change; pushed screens and forms open over it. Only for a member
 * linked to an employee, since everything in the menu is their own.
 */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus } from 'lucide-react-native';

import { AddSheet } from '@/components/AddSheet';
import { useSelfState } from '@/components/MyHrGate';
import { FloatingButton, floatingButtonBottom } from '@/components/Screen';
import { useI18n } from '@/lib/i18n';

export function AddButton() {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const state = useSelfState();
  const [open, setOpen] = useState(false);
  if (state.status !== 'ready') return null;

  return (
    <>
      <View style={[styles.slot, { bottom: floatingButtonBottom(insets.bottom) }]} pointerEvents="box-none">
        <FloatingButton icon={Plus} label={t.home.add} onPress={() => setOpen(true)} testID="tab-add" />
      </View>
      {open ? <AddSheet self={state.self} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  // Lined up with the tab bar's right edge (it keeps 20pt from the side).
  slot: { position: 'absolute', right: 20 },
});
