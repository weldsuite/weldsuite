/**
 * Rendered invoice document.
 *
 * `GET /api/invoices/:id/pdf` returns styled HTML, not a binary PDF, so the
 * markup is fetched with the auth token and handed to a WebView as inline
 * source. That also means the share sheet gets the HTML itself — there is no
 * file to attach.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Share } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams } from 'expo-router';
import { Share2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import api from '@/services/api';
import { Screen, ScreenHeader } from '@/components/screen';
import { LoadingState, ErrorState } from '@/components/data-states';

export default function InvoiceDocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const toast = useToast();

  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      setHtml(await api.getInvoiceDocumentHtml(id));
    } catch (err) {
      console.error('Failed to load invoice document:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleShare = useCallback(async () => {
    if (!html) return;
    try {
      await Share.share({ message: html });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not share the document');
    }
  }, [html, toast]);

  const header = (
    <ScreenHeader
      title="Invoice document"
      showBack
      actions={
        html ? (
          <IconButton
            icon={<Share2 size={20} color={colors.text} />}
            accessibilityLabel="Share document"
            onPress={handleShare}
          />
        ) : null
      }
    />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <LoadingState label="Rendering document…" />
      </Screen>
    );
  }

  if (error || !html) {
    return (
      <Screen header={header}>
        <ErrorState
          message="Couldn't render this invoice."
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        // The document is self-contained markup from our own API; it has no
        // scripts and should not be able to navigate anywhere.
        javaScriptEnabled={false}
        onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#FFFFFF' },
});
