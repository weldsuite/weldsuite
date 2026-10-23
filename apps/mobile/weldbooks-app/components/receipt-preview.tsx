/**
 * The scanned receipt next to the figures typed from it: a thumbnail card that
 * opens the photo full screen. Used on the quick expense and bill forms (local
 * photo) and on the bill detail (the stored document, read with the member's bearer).
 */

import { useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
// expo-image, not React Native's <Image>: on Android that one drops `source.headers`,
// so a file in private storage answers 401.
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Maximize2, Receipt, X } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import api from '@/services/api';
import { SectionCard } from '@/components/detail';
import { useI18n } from '@/lib/i18n';

export function ReceiptPreview({
  uri,
  headers,
  loading = false,
  style,
}: Readonly<{
  uri: string | null | undefined;
  /** Sent with the image request: the bearer for a file in private storage. */
  headers?: Record<string, string>;
  loading?: boolean;
  style?: React.ComponentProps<typeof SectionCard>['style'];
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!uri && !loading) return null;

  let body: React.ReactNode;
  if (loading || !uri) {
    body = <ActivityIndicator color={colors.mutedForeground} />;
  } else if (failed) {
    body = (
      <View style={styles.placeholder}>
        <Receipt size={22} color={colors.mutedForeground} />
        <Text style={[styles.placeholderText, { color: colors.mutedForeground }]}>
          {t.receipt.unavailable}
        </Text>
      </View>
    );
  } else {
    body = (
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={t.receipt.open}
        testID="receipt-preview"
        style={styles.thumbPress}
      >
        <Image
          source={{ uri, headers }}
          style={styles.thumb}
          contentFit="contain"
          onError={() => setFailed(true)}
        />
        <View style={styles.expandBadge}>
          <Maximize2 size={14} color="#fff" />
        </View>
      </Pressable>
    );
  }

  return (
    <SectionCard title={t.receipt.title} style={style}>
      <View style={[styles.frame, { backgroundColor: colors.secondary }]}>{body}</View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <View style={styles.viewer}>
          {uri ? <Image source={{ uri, headers }} style={styles.full} contentFit="contain" /> : null}
          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t.receipt.close}
            hitSlop={12}
            style={[styles.close, { top: insets.top + 12 }]}
          >
            <X size={22} color="#fff" />
          </Pressable>
        </View>
      </Modal>
    </SectionCard>
  );
}

/**
 * The receipt a bill was booked from (`sourceDocumentId`), loaded from storage.
 * Nothing renders for a bill without one, or for a PDF (an <Image> cannot show it).
 */
export function StoredReceipt({
  documentId,
  style,
}: Readonly<{ documentId: string | null | undefined; style?: React.ComponentProps<typeof SectionCard>['style'] }>) {
  const [state, setState] = useState<{
    uri: string | null;
    headers?: Record<string, string>;
    loading: boolean;
  }>({ uri: null, loading: Boolean(documentId) });

  useEffect(() => {
    if (!documentId) {
      setState({ uri: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ uri: null, loading: true });
    api
      .getDocumentFile(documentId)
      .then((file) => {
        if (cancelled) return;
        const isImage = !file?.mimeType || file.mimeType.startsWith('image/');
        setState(
          file && isImage
            ? { uri: file.uri, headers: file.headers, loading: false }
            : { uri: null, loading: false },
        );
      })
      .catch((err) => {
        console.error('Failed to load the receipt:', err);
        if (!cancelled) setState({ uri: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  return <ReceiptPreview uri={state.uri} headers={state.headers} loading={state.loading} style={style} />;
}

const styles = StyleSheet.create({
  frame: {
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPress: { width: '100%', height: '100%' },
  thumb: { width: '100%', height: '100%' },
  expandBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: { alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  placeholderText: { fontSize: 13, textAlign: 'center' },
  viewer: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  full: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
