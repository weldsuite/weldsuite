import React from 'react';
import { Modal, KeyboardAvoidingView, TouchableOpacity, StyleSheet, Platform } from 'react-native';

interface CenteredModalShellProps {
  visible: boolean;
  onClose: () => void;
  /** Wrap in a KeyboardAvoidingView (for dialogs that contain text inputs). */
  keyboardAvoiding?: boolean;
  children: React.ReactNode;
}

/**
 * Shared scaffolding for the app's centered dialog modals — extracted verbatim
 * from CreateLabelDialog / LabelPickerModal / SnoozePickerModal: the same fade
 * Modal, the same dimmed backdrop that dismisses on press, and the same inner
 * press-stopper. Per-dialog sizing and content stay in `children`, so the
 * rendered appearance is unchanged.
 */
export default function CenteredModalShell({
  visible,
  onClose,
  keyboardAvoiding = false,
  children,
}: CenteredModalShellProps) {
  const body = (
    <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={() => {}}>
        {children}
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.backdrop}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
