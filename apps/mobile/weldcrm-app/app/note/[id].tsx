import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Star, Trash2 } from 'lucide-react-native';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { FormField, FormScreen } from '@/components/form';
import { StackHeader } from '@/components/headers';
import { RecordRefField } from '@/components/record-ref-field';
import { notesApi, type NoteRecord, type RecordKind, type RecordRef } from '@/services/notes';
import { interpolate, useI18n } from '@/lib/i18n';
import { htmlToText, isPlainNoteHtml, splitNote } from '@/lib/note-text';

/**
 * `/note/new` creates a note (optionally for `recordKind` + `recordId`);
 * `/note/<id>` opens one to edit.
 */
export default function NoteScreen() {
  const params = useLocalSearchParams<{ id: string; recordKind?: RecordKind; recordId?: string; recordName?: string }>();
  const isNew = params.id === 'new';
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();

  const [note, setNote] = useState<NoteRecord | null>(null);
  const [loading, setLoading] = useState(!isNew);
  // A note that failed to load gets a retry screen, not an empty editor whose save would overwrite it.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [record, setRecord] = useState<RecordRef | undefined>(
    params.recordKind && params.recordId
      ? { kind: params.recordKind, id: params.recordId, name: params.recordName }
      : undefined,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    void (async () => {
      const res = await notesApi.get(params.id);
      if (res.success && res.data) {
        const parts = splitNote(res.data.html);
        setNote(res.data);
        setTitle(parts.title || (parts.body ? '' : res.data.subject));
        setBody(parts.body);
        setRecord(res.data.record);
      } else {
        setLoadFailed(true);
      }
      setLoading(false);
    })();
  }, [isNew, params.id, loadAttempt]);

  const retryLoad = () => {
    setLoadFailed(false);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  // A note the web formatted (lists, bold, links) is shown, not edited, so saving can't strip it.
  const readOnly = !!note && !isPlainNoteHtml(note.html);

  const handleSave = async () => {
    if (!isNew && !note) return;
    if (!title.trim() && !body.trim()) {
      setError(t.notes.emptyError);
      return;
    }
    setError(null);
    setSaving(true);
    const parts = { title, body };
    const res = isNew ? await notesApi.create(parts, record) : await notesApi.update(params.id, parts);
    setSaving(false);
    if (res.success) {
      toast.success(isNew ? t.notes.createdToast : t.notes.savedToast);
      router.back();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.notes.saveFailed);
    }
  };

  const toggleFavorite = async () => {
    if (!note) return;
    const next = !note.isFavorite;
    setNote({ ...note, isFavorite: next });
    const res = await notesApi.setFavorite(note.id, next);
    if (!res.success) {
      setNote({ ...note, isFavorite: !next });
      toast.error(t.notes.saveFailed);
    }
  };

  const handleDelete = () => {
    if (!note) return;
    Alert.alert(t.notes.deleteTitle, interpolate(t.notes.deleteMessage, { title: note.subject }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = await notesApi.remove(note.id);
            if (res.success) {
              toast.success(t.notes.deletedToast);
              router.back();
            } else {
              toast.error(t.notes.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={t.notes.title} onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      </View>
    );
  }

  if (loadFailed) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={t.notes.title} onBack={() => router.back()} />
        <View style={styles.center}>
          <EmptyState
            title={t.notes.loadNoteFailed}
            action={<Button title={t.common.tryAgain} variant="outline" onPress={retryLoad} />}
          />
        </View>
      </View>
    );
  }

  const headerActions = note ? (
    <>
      <TouchableOpacity
        onPress={() => void toggleFavorite()}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={note.isFavorite ? t.notes.unpin : t.notes.pin}
      >
        <Star size={20} color={note.isFavorite ? '#F59E0B' : colors.text} fill={note.isFavorite ? '#F59E0B' : 'none'} />
      </TouchableOpacity>
      <TouchableOpacity onPress={handleDelete} style={styles.iconButton} accessibilityRole="button" accessibilityLabel={t.common.delete}>
        <Trash2 size={20} color={colors.destructive} />
      </TouchableOpacity>
    </>
  ) : null;

  if (readOnly && note) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={note.subject} onBack={() => router.back()} right={headerActions} />
        <View style={styles.readOnly}>
          <Text style={[styles.hint, { color: colors.muted }]}>{t.notes.formattedHint}</Text>
          <Text style={[styles.readOnlyText, { color: colors.text }]}>{htmlToText(note.html)}</Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={isNew ? t.notes.newTitle : t.notes.editTitle}
        onClose={() => router.back()}
        submitLabel={t.common.save}
        onSubmit={() => void handleSave()}
        submitting={saving}
        headerRight={headerActions}
      >
        <FormField
          label={t.notes.fieldTitle}
          value={title}
          onChangeText={setTitle}
          placeholder={t.notes.titlePlaceholder}
          autoCapitalize="sentences"
          error={error}
        />
        <FormField
          label={t.notes.fieldBody}
          value={body}
          onChangeText={setBody}
          placeholder={t.notes.bodyPlaceholder}
          multiline
          numberOfLines={10}
        />
        <RecordRefField
          label={t.notes.fieldRecord}
          value={record}
          onChange={setRecord}
          // The record a note belongs to is set when it is written; the web doesn't move notes either.
          disabled={!isNew}
        />
      </FormScreen>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  iconButton: { padding: 8 },
  readOnly: { padding: 16, gap: 12 },
  hint: { fontSize: 13 },
  readOnlyText: { fontSize: 15, lineHeight: 22 },
});
