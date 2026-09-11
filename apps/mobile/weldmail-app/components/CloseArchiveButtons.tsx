import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Check, X } from 'lucide-react-native';

/**
 * Grouped Continue | Archive-and-next control matching the web message header
 * (`message-detail.tsx`: X / Check). X leaves the current email in the inbox
 * and opens the next row; Check archives it and opens the next row.
 */
export default function CloseArchiveButtons({
  onClose,
  onArchiveAndNext,
  borderColor,
  iconColor,
  archiveDisabled,
}: {
  onClose: () => void;
  onArchiveAndNext: () => void;
  borderColor: string;
  iconColor: string;
  archiveDisabled?: boolean;
}) {
  return (
    <View style={[styles.group, { borderColor }]}>
      <TouchableOpacity
        onPress={onClose}
        style={styles.btn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 4 }}
        accessibilityRole="button"
        accessibilityLabel="Continue to next"
        activeOpacity={0.7}
      >
        <X size={16} color={iconColor} strokeWidth={2} />
      </TouchableOpacity>
      <View style={[styles.divider, { backgroundColor: borderColor }]} />
      <TouchableOpacity
        onPress={onArchiveAndNext}
        style={[styles.btn, archiveDisabled ? { opacity: 0.35 } : null]}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 6 }}
        accessibilityRole="button"
        accessibilityLabel="Archive and open next"
        disabled={archiveDisabled}
        activeOpacity={0.7}
      >
        <Check size={16} color={iconColor} strokeWidth={2} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    overflow: 'hidden',
  },
  btn: {
    width: 34,
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
  },
});
