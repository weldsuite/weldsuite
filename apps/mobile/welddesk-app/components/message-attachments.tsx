/** Attachments of a desk message: image thumbnails and tappable file rows. */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { FileText } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { formatFileSize, isImageAttachment, isOpenableUrl } from '@/lib/attachments';
import { useI18n } from '@/lib/i18n';
import type { DeskMessageAttachment } from '@/types/desk';

const THUMB_SIZE = 160;

interface MessageAttachmentsProps {
  attachments: DeskMessageAttachment[] | null | undefined;
  /** The bubble is brand-coloured (agent reply), so use light text and surfaces. */
  onBrand?: boolean;
}

export function MessageAttachments({ attachments, onBrand = false }: Readonly<MessageAttachmentsProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();

  if (!attachments || attachments.length === 0) return null;

  const open = async (url: string) => {
    if (!isOpenableUrl(url)) {
      toast.error(t.conversation.attachmentOpenError);
      return;
    }
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      toast.error(t.conversation.attachmentOpenError);
    }
  };

  const textColor = onBrand ? '#fff' : colors.text;
  const mutedColor = onBrand ? 'rgba(255,255,255,0.75)' : colors.mutedForeground;
  const rowBackground = onBrand ? 'rgba(255,255,255,0.18)' : colors.background;

  return (
    <View style={styles.list}>
      {attachments.map((attachment, index) => {
        const key = `${attachment.url}-${index}`;
        const name = attachment.name || t.conversation.attachment;

        if (isImageAttachment(attachment) && isOpenableUrl(attachment.url)) {
          return (
            <Pressable
              key={key}
              onPress={() => void open(attachment.url)}
              accessibilityRole="imagebutton"
              accessibilityLabel={name}
            >
              <Image
                source={{ uri: attachment.url }}
                style={[styles.thumb, { backgroundColor: rowBackground }]}
                contentFit="cover"
                accessibilityLabel={name}
              />
            </Pressable>
          );
        }

        const size = formatFileSize(attachment.filesize);
        return (
          <Pressable
            key={key}
            onPress={() => void open(attachment.url)}
            accessibilityRole="link"
            accessibilityLabel={name}
            style={[styles.fileRow, { backgroundColor: rowBackground }]}
          >
            <FileText size={18} color={textColor} />
            <View style={styles.fileText}>
              <Text style={[styles.fileName, { color: textColor }]} numberOfLines={1}>
                {name}
              </Text>
              {size ? <Text style={[styles.fileSize, { color: mutedColor }]}>{size}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  thumb: { width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: 10 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 160,
  },
  fileText: { flexShrink: 1 },
  fileName: { fontSize: 14, fontWeight: '500' },
  fileSize: { fontSize: 11, marginTop: 1 },
});
