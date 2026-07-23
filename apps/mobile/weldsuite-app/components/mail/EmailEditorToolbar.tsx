import React from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Text,
} from 'react-native';
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Paperclip,
  ChevronDown,
} from 'lucide-react-native';
import { EditorBridge, useBridgeState } from '@10play/tentap-editor';

interface EmailEditorToolbarProps {
  editor: EditorBridge;
  onAttachmentPress?: () => void;
  onBeforeAction?: () => void;
  colors: {
    text: string;
    border: string;
    muted: string;
  };
}

interface ToolbarButtonProps {
  icon: React.ReactNode;
  onPress: () => void;
  isActive?: boolean;
}

function ToolbarButton({ icon, onPress, isActive }: ToolbarButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, isActive && styles.buttonActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {icon}
    </TouchableOpacity>
  );
}

export function EmailEditorToolbar({
  editor,
  onAttachmentPress,
  onBeforeAction,
  colors,
}: EmailEditorToolbarProps) {
  // Get editor state to track active formatting
  const editorState = useBridgeState(editor);

  const isBold = editorState.isBoldActive;
  const isItalic = editorState.isItalicActive;
  const isUnderline = editorState.isUnderlineActive;
  const isBulletList = editorState.isBulletListActive;
  const isOrderedList = editorState.isOrderedListActive;

  // Wrap editor actions to call onBeforeAction first
  const handleAction = (action: () => void) => {
    onBeforeAction?.();
    action();
  };

  return (
    <View style={[styles.container, { borderColor: colors.border }]}>
      <TouchableOpacity style={styles.fontSizeButton}>
        <Text style={[styles.fontSizeText, { color: colors.text }]}>14</Text>
        <ChevronDown size={14} color={colors.text} strokeWidth={2} />
      </TouchableOpacity>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <ToolbarButton
        icon={<Bold size={18} color={colors.text} strokeWidth={2.5} />}
        onPress={() => handleAction(() => editor.toggleBold())}
        isActive={isBold}
      />
      <ToolbarButton
        icon={<Italic size={18} color={colors.text} strokeWidth={2} />}
        onPress={() => handleAction(() => editor.toggleItalic())}
        isActive={isItalic}
      />
      <ToolbarButton
        icon={<Underline size={18} color={colors.text} strokeWidth={2} />}
        onPress={() => handleAction(() => editor.toggleUnderline())}
        isActive={isUnderline}
      />

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <ToolbarButton
        icon={<List size={18} color={colors.text} strokeWidth={2} />}
        onPress={() => handleAction(() => editor.toggleBulletList())}
        isActive={isBulletList}
      />
      <ToolbarButton
        icon={<ListOrdered size={18} color={colors.text} strokeWidth={2} />}
        onPress={() => handleAction(() => editor.toggleOrderedList())}
        isActive={isOrderedList}
      />

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <ToolbarButton
        icon={<Paperclip size={18} color={colors.text} strokeWidth={2} />}
        onPress={() => onAttachmentPress?.()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 4,
    borderWidth: 1,
    borderRadius: 10,
  },
  fontSizeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
  },
  fontSizeText: {
    fontSize: 14,
    fontWeight: '500',
  },
  divider: {
    width: 1,
    height: 20,
    marginHorizontal: 8,
  },
  button: {
    padding: 8,
    borderRadius: 6,
  },
  buttonActive: {
    backgroundColor: '#E5E7EB',
  },
});
