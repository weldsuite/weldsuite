import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWeldmeetApi } from '@/services/app-api';

export default function NewMeetingScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { weldmeet } = useWeldmeetApi();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [audioOnly, setAudioOnly] = useState(false);
  const [recording, setRecording] = useState(true);
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [busy, setBusy] = useState(false);

  const onCreate = async () => {
    if (!title.trim()) {
      Alert.alert('Title required', 'Please give your meeting a title.');
      return;
    }
    setBusy(true);
    try {
      const res = await weldmeet.createMeeting({
        title: title.trim(),
        description: description.trim() || undefined,
        meetingType: audioOnly ? 'audio' : 'video',
        allowRecording: recording,
        waitingRoom,
        accessType: 'workspace',
        // Defaulted by Zod, but listed explicitly so the type matches the
        // schema's required (post-default) shape.
        attendees: [],
        isRecurring: false,
        createCalendarEvent: false,
      });
      router.replace(`/meeting/${res.data.id}`);
    } catch (err) {
      Alert.alert(
        'Could not create meeting',
        err instanceof Error ? err.message : 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New meeting</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.label, { color: colors.muted }]}>Title</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Weekly sync"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
        />

        <Text style={[styles.label, { color: colors.muted }]}>Description</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What's this meeting about?"
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={4}
          style={[
            styles.input,
            styles.textarea,
            { color: colors.text, backgroundColor: colors.card, borderColor: colors.border },
          ]}
        />

        <View style={[styles.toggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.toggleLabel}>
            <Text style={[styles.toggleTitle, { color: colors.text }]}>Audio-only</Text>
            <Text style={[styles.toggleSub, { color: colors.muted }]}>Disable video for everyone</Text>
          </View>
          <Switch value={audioOnly} onValueChange={setAudioOnly} trackColor={{ true: '#7C3AED' }} />
        </View>

        <View style={[styles.toggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.toggleLabel}>
            <Text style={[styles.toggleTitle, { color: colors.text }]}>Allow recording</Text>
            <Text style={[styles.toggleSub, { color: colors.muted }]}>Organizer can record the call</Text>
          </View>
          <Switch value={recording} onValueChange={setRecording} trackColor={{ true: '#7C3AED' }} />
        </View>

        <View style={[styles.toggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.toggleLabel}>
            <Text style={[styles.toggleTitle, { color: colors.text }]}>Waiting room</Text>
            <Text style={[styles.toggleSub, { color: colors.muted }]}>Admit attendees one by one</Text>
          </View>
          <Switch value={waitingRoom} onValueChange={setWaitingRoom} trackColor={{ true: '#7C3AED' }} />
        </View>

        <Pressable
          onPress={onCreate}
          disabled={busy}
          style={({ pressed }) => [styles.createBtn, { opacity: pressed || busy ? 0.7 : 1 }]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createText}>Create meeting</Text>}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  scroll: { padding: 16, paddingBottom: 64 },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginTop: 12, marginBottom: 6 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  textarea: { minHeight: 96, textAlignVertical: 'top' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
  },
  toggleLabel: { flex: 1, marginRight: 12 },
  toggleTitle: { fontSize: 15, fontWeight: '500' },
  toggleSub: { fontSize: 13, marginTop: 2 },
  createBtn: {
    backgroundColor: '#7C3AED',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  createText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
