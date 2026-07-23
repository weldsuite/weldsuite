import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';

interface ConfirmModalProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { colors } = useTheme();

  const confirmButtonStyle = variant === 'destructive'
    ? { backgroundColor: '#dc2626' }
    : { backgroundColor: colors.text };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.modal, { backgroundColor: colors.background }]}>
              <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
              {message && (
                <Text style={[styles.message, { color: colors.muted }]}>{message}</Text>
              )}
              <View style={styles.buttons}>
                <TouchableOpacity
                  style={[styles.button, styles.cancelButton, { borderColor: colors.divider }]}
                  onPress={onCancel}
                  disabled={loading}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.cancelButtonText, { color: colors.text }]}>
                    {cancelText}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.confirmButton, confirmButtonStyle]}
                  onPress={onConfirm}
                  disabled={loading}
                  activeOpacity={0.7}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.confirmButtonText}>{confirmText}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modal: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 24,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelButton: {
    borderWidth: 1,
  },
  confirmButton: {},
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
});

export default ConfirmModal;
