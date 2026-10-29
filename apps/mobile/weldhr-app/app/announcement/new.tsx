/**
 * Posting an announcement, for people who may (`announcements:create`), from
 * the "+" on Announcements: a title, the message, whether it stays on top and
 * whether everyone gets a push about it. It goes to every employee; picking
 * departments stays in WeldHR on the web.
 */

import { useRef, useState } from 'react';
import { StyleSheet, type TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { FormField, FormHint, FormInput, FormOptions, FormScreen, FormSwitch } from '@/components/Form';
import { useCreateAnnouncement } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

export default function NewAnnouncementScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateAnnouncement();
  const messageRef = useRef<TextInput>(null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canPost = title.trim().length > 0 && body.trim().length > 0 && !create.isPending;

  const post = () => {
    if (!canPost) return;
    setError(null);
    create.mutate(
      { title: title.trim(), body: body.trim(), pinned, notify },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.announcementForm.posted);
          router.back();
        },
        onError: () => setError(t.announcementForm.failed),
      },
    );
  };

  return (
    <FormScreen
      title={t.announcementForm.title}
      action={{
        label: t.announcementForm.post,
        onPress: post,
        disabled: !canPost,
        loading: create.isPending,
        testID: 'announcement-submit',
      }}
    >
      <FormField label={t.announcementForm.titleLabel}>
        <FormInput
          value={title}
          onChangeText={(text) => {
            setTitle(text);
            setError(null);
          }}
          placeholder={t.announcementForm.titlePlaceholder}
          autoFocus
          autoCapitalize="sentences"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => messageRef.current?.focus()}
          maxLength={200}
          accessibilityLabel={t.announcementForm.titleLabel}
          testID="announcement-title"
        />
      </FormField>

      <FormField label={t.announcementForm.body}>
        <FormInput
          ref={messageRef}
          style={styles.message}
          value={body}
          onChangeText={(text) => {
            setBody(text);
            setError(null);
          }}
          placeholder={t.announcementForm.bodyPlaceholder}
          multiline
          autoCapitalize="sentences"
          maxLength={20000}
          accessibilityLabel={t.announcementForm.body}
          testID="announcement-body"
        />
        {error ? <FormHint error>{error}</FormHint> : null}
      </FormField>

      <FormOptions>
        <FormSwitch
          title={t.announcementForm.pinned}
          hint={t.announcementForm.pinnedHint}
          value={pinned}
          onChange={setPinned}
        />
        <FormSwitch
          title={t.announcementForm.notify}
          hint={t.announcementForm.notifyHint}
          value={notify}
          onChange={setNotify}
        />
      </FormOptions>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  // A few paragraphs in view.
  message: { minHeight: 160 },
});
