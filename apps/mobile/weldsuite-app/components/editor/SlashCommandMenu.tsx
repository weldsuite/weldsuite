import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Minus,
  Link as LinkIcon,
  X,
} from 'lucide-react-native';
import type { EditorBridge } from '@10play/tentap-editor';

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
}

interface SlashCommandMenuProps {
  editor: EditorBridge;
  visible: boolean;
  onClose: () => void;
  onLinkPress?: () => void;
}

export function SlashCommandMenu({
  editor,
  visible,
  onClose,
  onLinkPress,
}: SlashCommandMenuProps) {
  const [filter, setFilter] = useState('');

  // Reset filter when menu opens
  useEffect(() => {
    if (visible) {
      setFilter('');
    }
  }, [visible]);

  const commands: SlashCommand[] = useMemo(() => [
    {
      id: 'text',
      label: 'Text',
      description: 'Just start writing with plain text',
      icon: <Type size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        // Clear formatting to paragraph
        editor.chain?.().clearNodes().run();
        onClose();
      },
    },
    {
      id: 'heading1',
      label: 'Heading 1',
      description: 'Big section heading',
      icon: <Heading1 size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleHeading(1);
        onClose();
      },
    },
    {
      id: 'heading2',
      label: 'Heading 2',
      description: 'Medium section heading',
      icon: <Heading2 size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleHeading(2);
        onClose();
      },
    },
    {
      id: 'heading3',
      label: 'Heading 3',
      description: 'Small section heading',
      icon: <Heading3 size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleHeading(3);
        onClose();
      },
    },
    {
      id: 'bulletlist',
      label: 'Bulleted List',
      description: 'Create a simple bulleted list',
      icon: <List size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleBulletList();
        onClose();
      },
    },
    {
      id: 'numberedlist',
      label: 'Numbered List',
      description: 'Create a list with numbering',
      icon: <ListOrdered size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleOrderedList();
        onClose();
      },
    },
    {
      id: 'quote',
      label: 'Quote',
      description: 'Capture a quote',
      icon: <Quote size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleBlockquote();
        onClose();
      },
    },
    {
      id: 'code',
      label: 'Code Block',
      description: 'Capture a code snippet',
      icon: <Code size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        editor.toggleCode();
        onClose();
      },
    },
    {
      id: 'divider',
      label: 'Divider',
      description: 'Visually divide blocks',
      icon: <Minus size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        // Insert horizontal rule using chain command
        editor.chain?.().setHorizontalRule?.().run();
        onClose();
      },
    },
    {
      id: 'link',
      label: 'Link',
      description: 'Add a hyperlink',
      icon: <LinkIcon size={20} color="#6B7280" strokeWidth={1.5} />,
      action: () => {
        onClose();
        onLinkPress?.();
      },
    },
  ], [editor, onClose, onLinkPress]);

  const filteredCommands = useMemo(() => {
    if (!filter) return commands;
    const lowerFilter = filter.toLowerCase();
    return commands.filter(
      cmd =>
        cmd.label.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter)
    );
  }, [commands, filter]);

  const renderItem = ({ item }: { item: SlashCommand }) => (
    <TouchableOpacity
      style={styles.commandItem}
      onPress={item.action}
      activeOpacity={0.7}
    >
      <View style={styles.commandIcon}>{item.icon}</View>
      <View style={styles.commandText}>
        <Text style={styles.commandLabel}>{item.label}</Text>
        <Text style={styles.commandDescription}>{item.description}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Insert Block</Text>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <X size={20} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search commands..."
              placeholderTextColor="#9CA3AF"
              value={filter}
              onChangeText={setFilter}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Commands */}
          <FlatList
            data={filteredCommands}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No commands found</Text>
              </View>
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  container: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  closeButton: {
    padding: 4,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  searchInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingBottom: 24,
  },
  commandItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginHorizontal: 8,
    borderRadius: 8,
  },
  commandIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  commandText: {
    flex: 1,
  },
  commandLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  commandDescription: {
    fontSize: 13,
    color: '#6B7280',
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
});
