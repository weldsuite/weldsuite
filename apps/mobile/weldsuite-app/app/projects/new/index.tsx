import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { ChevronLeft, Calendar } from 'lucide-react-native';
import api from '@/services/api';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#10B981' },
  { value: 'medium', label: 'Medium', color: '#F59E0B' },
  { value: 'high', label: 'High', color: '#EF4444' },
  { value: 'urgent', label: 'Urgent', color: '#DC2626' },
];

const COLOR_OPTIONS = [
  '#3B82F6', // Blue
  '#10B981', // Green
  '#F59E0B', // Yellow
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
];

export default function NewProjectScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState('');
  const [priority, setPriority] = useState('medium');
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [loading, setLoading] = useState(false);

  const generateKey = (projectName: string) => {
    return projectName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4) || 'PROJ';
  };

  const handleNameChange = (text: string) => {
    setName(text);
    if (!key || key === generateKey(name)) {
      setKey(generateKey(text));
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('Please enter a project name');
      return;
    }

    setLoading(true);
    try {
      const response = await api.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        key: key.trim() || generateKey(name),
        priority,
        color,
      });

      if (response.success) {
        toast.success('Project created successfully');
        router.back();
      } else {
        toast.error(response.error || 'Failed to create project');
      }
    } catch (error) {
      console.error('Error creating project:', error);
      toast.error('Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            New Project
          </Text>
          <View style={styles.headerRight} />
        </View>

        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Project Name */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Project Name *
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.divider,
                  color: colors.text,
                },
              ]}
              placeholder="Enter project name"
              placeholderTextColor={colors.muted}
              value={name}
              onChangeText={handleNameChange}
              autoFocus
            />
          </View>

          {/* Project Key */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Project Key
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.divider,
                  color: colors.text,
                },
              ]}
              placeholder="e.g., PROJ"
              placeholderTextColor={colors.muted}
              value={key}
              onChangeText={setKey}
              autoCapitalize="characters"
              maxLength={6}
            />
            <Text style={[styles.hint, { color: colors.muted }]}>
              Used as prefix for task IDs (e.g., {key || 'PROJ'}-1)
            </Text>
          </View>

          {/* Description */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Description
            </Text>
            <TextInput
              style={[
                styles.input,
                styles.textArea,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.divider,
                  color: colors.text,
                },
              ]}
              placeholder="Describe your project..."
              placeholderTextColor={colors.muted}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* Priority */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Priority
            </Text>
            <View style={styles.optionsRow}>
              {PRIORITY_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.priorityOption,
                    {
                      backgroundColor:
                        priority === option.value
                          ? option.color + '20'
                          : colors.background,
                      borderColor:
                        priority === option.value ? option.color : colors.divider,
                    },
                  ]}
                  onPress={() => setPriority(option.value)}
                >
                  <View
                    style={[
                      styles.priorityDot,
                      { backgroundColor: option.color },
                    ]}
                  />
                  <Text
                    style={[
                      styles.priorityLabel,
                      {
                        color:
                          priority === option.value ? option.color : colors.text,
                      },
                    ]}
                  >
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Color */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Project Color
            </Text>
            <View style={styles.colorRow}>
              {COLOR_OPTIONS.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[
                    styles.colorOption,
                    { backgroundColor: c },
                    color === c && styles.colorOptionSelected,
                  ]}
                  onPress={() => setColor(c)}
                >
                  {color === c && (
                    <View style={styles.colorCheck}>
                      <Text style={styles.colorCheckText}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Create Button */}
          <TouchableOpacity
            style={[
              styles.createButton,
              { backgroundColor: color },
              loading && styles.createButtonDisabled,
            ]}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.createButtonText}>Create Project</Text>
            )}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  headerRight: {
    width: 32,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  field: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  textArea: {
    minHeight: 100,
    paddingTop: 12,
  },
  hint: {
    fontSize: 12,
    marginTop: 6,
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  priorityOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  priorityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  priorityLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  colorOption: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  colorOptionSelected: {
    borderWidth: 3,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  colorCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  colorCheckText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#000',
  },
  createButton: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  createButtonDisabled: {
    opacity: 0.7,
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
