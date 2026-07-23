import { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Hash, Lock, Check, FolderPlus, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';

interface Section {
  id: string;
  name: string;
  position: number;
}

export default function NewChannelScreen() {
  // Optional category to pre-select (e.g. tapping "Add channel" under an empty
  // section on the home screen).
  const params = useLocalSearchParams<{ sectionId?: string }>();
  const [name, setName] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');
  const [sectionId, setSectionId] = useState<string | undefined>(
    typeof params.sectionId === 'string' ? params.sectionId : undefined,
  );
  const [sections, setSections] = useState<Section[]>([]);
  const [creating, setCreating] = useState(false);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingSec, setCreatingSec] = useState(false);
  const categoryInputRef = useRef<TextInput>(null);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);

  useEffect(() => {
    appApi.chatSections.list().then((res) => {
      const data = (res.data || []) as unknown as Section[];
      setSections(data);
      if (data.length > 0) setSectionId(data[0].id);
    }).catch((err) => {
      console.error(err);
    });
  }, []);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const res = await appApi.channels.create({
        name: name.trim(),
        type,
        sectionId,
      });
      if (res.data?.id) {
        router.dismiss();
        router.push(`/channel/${res.data.id}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim() || creatingSec) return;
    setCreatingSec(true);
    try {
      const trimmed = newCategoryName.trim();
      const res = await appApi.chatSections.create({ name: trimmed });
      if (res.data?.id) {
        const created: Section = { id: res.data.id, name: trimmed, position: sections.length };
        setSections((prev) => [...prev, created]);
        setSectionId(created.id);
        setNewCategoryName('');
        setShowNewCategory(false);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCreatingSec(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {/* Handle */}
        <View style={styles.handleBar}>
          <View style={styles.handle} />
        </View>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerSide}>
            <Text style={styles.cancelBtn}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>New Channel</Text>
          <TouchableOpacity
            onPress={handleCreate}
            disabled={!name.trim() || creating}
            style={[styles.headerSide, { alignItems: 'flex-end' }]}
          >
            {creating ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : (
              <Text style={[styles.createBtn, !name.trim() && styles.createBtnDisabled]}>
                Create
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          {/* Channel name input */}
          <View style={styles.inputSection}>
            <View style={styles.inputRow}>
              {type === 'private' ? (
                <Lock size={20} color={colors.textMuted} />
              ) : (
                <Hash size={20} color={colors.textMuted} />
              )}
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={(text) => setName(text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))}
                placeholder="channel-name"
                placeholderTextColor={colors.textMuted}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          {/* Private toggle */}
          <View style={styles.toggleRow}>
            <Lock size={20} color={colors.textPrimary} />
            <Text style={styles.toggleTitle}>Private channel</Text>
            <Switch
              value={type === 'private'}
              onValueChange={(val) => setType(val ? 'private' : 'public')}
              trackColor={{ false: colors.bgTertiary, true: colors.textPrimary }}
              thumbColor="#fff"
            />
          </View>

          {/* Category picker */}
          <Text style={styles.sectionLabel}>CATEGORY</Text>
          <View style={styles.sectionList}>
            {sections.map((sec) => (
              <TouchableOpacity
                key={sec.id}
                style={[styles.sectionItem, sectionId === sec.id && styles.sectionItemActive]}
                onPress={() => setSectionId(sec.id)}
              >
                <Text
                  style={[styles.sectionItemText, sectionId === sec.id && styles.sectionItemTextActive]}
                  numberOfLines={1}
                >
                  {sec.name}
                </Text>
                {sectionId === sec.id && <Check size={18} color={colors.brand} />}
              </TouchableOpacity>
            ))}

            {/* New category inline input */}
            {showNewCategory ? (
              <View style={styles.newCategoryRow}>
                <TextInput
                  ref={categoryInputRef}
                  style={styles.newCategoryInput}
                  value={newCategoryName}
                  onChangeText={setNewCategoryName}
                  placeholder="Category name"
                  placeholderTextColor={colors.textMuted}
                  autoFocus
                  autoCapitalize="words"
                  returnKeyType="done"
                  onSubmitEditing={handleCreateCategory}
                />
                {creatingSec ? (
                  <ActivityIndicator size="small" color={colors.brand} />
                ) : (
                  <>
                    <TouchableOpacity
                      onPress={handleCreateCategory}
                      disabled={!newCategoryName.trim()}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Check size={20} color={newCategoryName.trim() ? colors.brand : colors.textMuted} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { setShowNewCategory(false); setNewCategoryName(''); }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <X size={20} color={colors.textMuted} />
                    </TouchableOpacity>
                  </>
                )}
              </View>
            ) : (
              <TouchableOpacity
                style={styles.sectionItem}
                onPress={() => setShowNewCategory(true)}
              >
                <FolderPlus size={18} color={colors.brand} />
                <Text style={[styles.sectionItemText, { color: colors.brand }]}>
                  New Category
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (c: ColorScheme, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    handleBar: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
    handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: c.bgAccent },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: c.bgTertiary,
    },
    headerSide: { width: 60 },
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    cancelBtn: { fontSize: 16, color: c.textPrimary, fontWeight: '500' },
    createBtn: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    createBtnDisabled: { opacity: 0.3 },
    inputSection: {
      marginHorizontal: 16,
      paddingTop: 24,
      marginBottom: 16,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: c.bgTertiary,
      borderRadius: 10,
      paddingHorizontal: 14,
    },
    input: {
      flex: 1,
      fontSize: 16,
      color: c.textPrimary,
      paddingVertical: 12,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 14,
      marginHorizontal: 16,
      marginBottom: 24,
      gap: 14,
      borderWidth: 1,
      borderColor: c.bgTertiary,
      borderRadius: 14,
    },
    toggleTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: c.textPrimary },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: c.textMuted,
      letterSpacing: 0.5,
      marginHorizontal: 16,
      marginBottom: 8,
    },
    sectionList: {
      marginHorizontal: 16,
      borderWidth: 1,
      borderColor: c.bgTertiary,
      borderRadius: 14,
      overflow: 'hidden',
    },
    sectionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 14,
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.bgTertiary,
    },
    sectionItemActive: {
      backgroundColor: c.bgSecondary,
    },
    sectionItemText: {
      flex: 1,
      fontSize: 16,
      color: c.textPrimary,
      fontWeight: '500',
    },
    sectionItemTextActive: {
      fontWeight: '600',
    },
    newCategoryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 14,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.bgTertiary,
    },
    newCategoryInput: {
      flex: 1,
      fontSize: 16,
      color: c.textPrimary,
      paddingVertical: 6,
    },
  });
