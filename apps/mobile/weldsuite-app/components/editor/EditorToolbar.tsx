import React from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Code,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
} from 'lucide-react-native';
import type { EditorBridge } from '@10play/tentap-editor';

interface EditorToolbarProps {
  editor: EditorBridge;
  onLinkPress?: () => void;
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

function ToolbarDivider() {
  return <View style={styles.divider} />;
}

export function EditorToolbar({ editor, onLinkPress }: EditorToolbarProps) {
  const iconColor = '#374151';
  const activeColor = '#111827';

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Text Formatting */}
        <ToolbarButton
          icon={<Bold size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleBold()}
        />
        <ToolbarButton
          icon={<Italic size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleItalic()}
        />
        <ToolbarButton
          icon={<Underline size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleUnderline()}
        />
        <ToolbarButton
          icon={<Strikethrough size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleStrike()}
        />

        <ToolbarDivider />

        {/* Headings */}
        <ToolbarButton
          icon={<Heading1 size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleHeading(1)}
        />
        <ToolbarButton
          icon={<Heading2 size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleHeading(2)}
        />
        <ToolbarButton
          icon={<Heading3 size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleHeading(3)}
        />

        <ToolbarDivider />

        {/* Lists */}
        <ToolbarButton
          icon={<List size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleBulletList()}
        />
        <ToolbarButton
          icon={<ListOrdered size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleOrderedList()}
        />

        <ToolbarDivider />

        {/* Blocks */}
        <ToolbarButton
          icon={<Quote size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleBlockquote()}
        />
        <ToolbarButton
          icon={<Code size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => editor.toggleCode()}
        />

        <ToolbarDivider />

        {/* Link */}
        <ToolbarButton
          icon={<LinkIcon size={18} color={iconColor} strokeWidth={2} />}
          onPress={() => onLinkPress?.()}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 48,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  scrollContent: {
    paddingHorizontal: 12,
    gap: 2,
    alignItems: 'center',
    height: 48,
  },
  button: {
    width: 36,
    height: 36,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonActive: {
    backgroundColor: '#F3F4F6',
  },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 6,
  },
});
