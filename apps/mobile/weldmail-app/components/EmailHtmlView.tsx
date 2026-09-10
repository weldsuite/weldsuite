import React, { useEffect, useRef, useState } from 'react';
import { Linking, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildEmailDocument,
  EMAIL_LAYOUT_PROBE,
  type EmailDocumentOptions,
} from '@/utils/email-html';

interface EmailHtmlViewProps extends EmailDocumentOptions {
  /** Raw (untrusted) email HTML body. */
  html: string;
  /** Initial height before the content reports its real size. */
  initialHeight?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Hardened, read-only renderer for received email HTML.
 *
 * SECURITY MODEL — email bodies are fully attacker-controlled. The hard
 * guarantees are:
 *  - a strict Content-Security-Policy (`default-src 'none'`, no `script-src`)
 *    injected around the body (see utils/email-html), so the engine blocks the
 *    email's inline <script>, inline event handlers and javascript: URIs even
 *    though the JS engine is on;
 *  - a regex sanitizer that strips <script>/<iframe>/on*=/javascript: as
 *    defense-in-depth;
 *  - blocked in-frame navigation — real web links open in the system browser
 *    instead (so a malicious body can't redirect/phish in-place);
 *  - constrained origins, disabled file access, no multiple windows, no mixed
 *    (cleartext) content.
 *
 * JavaScript is enabled ONLY so the host-injected EMAIL_LAYOUT_PROBE can
 * measure content height and clamp fixed-width layouts (`javaScriptEnabled=
 * {false}` makes iOS never fire `onContentSizeChange`, freezing the body at
 * `initialHeight`). The page's own scripts remain blocked by the CSP above, so
 * enabling the engine does not let attacker code run. Height is authoritative
 * from the injected probe, with native `onContentSizeChange` as a fallback
 * until the first probe arrives.
 */
export default function EmailHtmlView({
  html,
  textColor,
  fontSize,
  lineHeight,
  hideQuotes,
  initialHeight = 200,
  style,
}: EmailHtmlViewProps) {
  const [height, setHeight] = useState(initialHeight);
  // Once the injected probe reports a sane height, it wins over the native
  // content-size callback (which can lag or clamp on iOS).
  const hasProbeHeight = useRef(false);
  const document = buildEmailDocument(html, { textColor, fontSize, lineHeight, hideQuotes });

  // New message ⇒ forget the previous probe lock, otherwise a collapsed height
  // from a bad early measurement sticks across opens.
  useEffect(() => {
    hasProbeHeight.current = false;
    setHeight(initialHeight);
  }, [html, initialHeight]);

  const onProbeMessage = (e: WebViewMessageEvent) => {
    const h = parseInt(e.nativeEvent.data, 10);
    // Reject near-zero measurements — those come from a probe that ran before
    // the WebView had a real layout width and would hide the whole body.
    if (Number.isFinite(h) && h >= 40 && h < 100000) {
      hasProbeHeight.current = true;
      setHeight(h);
    }
  };

  return (
    // Clip residual horizontal overflow so a wide ESP table cannot expand the
    // parent ScrollView into a horizontal pan. Vertical size comes from `height`.
    <View style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', alignSelf: 'stretch' }}>
      <WebView
        source={{ html: document }}
        style={[style, { height, width: '100%', alignSelf: 'stretch' }]}
        // Only the inline document (about:blank / data:) may load in-frame.
        originWhitelist={['about:*', 'data:*']}
        // Engine on strictly for the host-injected layout probe; the email's own
        // scripts are blocked by the document CSP (default-src 'none').
        javaScriptEnabled
        injectedJavaScript={EMAIL_LAYOUT_PROBE}
        onMessage={onProbeMessage}
        scrollEnabled={false}
        // Android: scale the page to the WebView width when content is wider.
        // Safe now that we no longer also apply transform:scale in the probe.
        scalesPageToFit
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        onShouldStartLoadWithRequest={(req) => {
          const url = req.url || '';
          // Allow the initial inline render.
          if (url === 'about:blank' || url === '' || url.startsWith('data:')) return true;
          // Open genuine web links externally; block everything else
          // (javascript:, file:, custom schemes, in-frame redirects).
          if (/^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => {});
          return false;
        }}
        onContentSizeChange={(e) => {
          // Fallback only: the injected probe is authoritative once it reports.
          if (hasProbeHeight.current) return;
          // `contentSize` is present at runtime but not in react-native-webview's
          // WebViewNativeEvent type, so narrow it explicitly rather than cast to any.
          const contentSize = (e.nativeEvent as { contentSize?: { height: number } }).contentSize;
          const h = contentSize ? Math.ceil(contentSize.height) : 0;
          if (h >= 40) setHeight(h);
        }}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
      />
    </View>
  );
}
