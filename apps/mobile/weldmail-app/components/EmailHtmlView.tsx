import React, { useEffect, useRef, useState } from 'react';
import { Linking, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildEmailDocument,
  EMAIL_CANVAS_BG,
  EMAIL_CANVAS_TEXT,
  EMAIL_LAYOUT_PROBE,
  INLINE_BASE_URL,
  isInlineDocumentLoad,
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
 * Rendering model matches platform `IsolatedHtmlContent` / Gmail / Outlook:
 * the message always sits on a WHITE canvas with dark default text — even when
 * the app is in dark mode.
 *
 * LOADING — react-native-webview requires `originWhitelist={['*']}` for
 * `source={{ html }}`. A tighter list (`about:*` / `data:*` only) leaves a
 * blank white/black pane because the engine's real bootstrap URL is often
 * `applewebdata://…` (iOS) or `file://…` (Android). Navigation safety is
 * enforced in `onShouldStartLoadWithRequest` instead: http(s), mailto: and
 * tel: open in the OS; javascript:/vbscript:/data: links are blocked; only the
 * inline document may render in-frame (see isInlineDocumentLoad).
 *
 * SECURITY MODEL — email bodies are fully attacker-controlled. Guarantees:
 *  - CSP (`default-src 'none'`, no script-src) around the body;
 *  - regex sanitizer strips script/iframe/on*=/javascript: as defense-in-depth;
 *  - blocked in-frame navigations (links open externally);
 *  - no file access, no multiple windows, no mixed cleartext content.
 *
 * JavaScript is enabled ONLY so the host-injected EMAIL_LAYOUT_PROBE can
 * measure height / clamp fixed widths. The email's own scripts stay blocked
 * by CSP.
 */
export default function EmailHtmlView({
  html,
  textColor = EMAIL_CANVAS_TEXT,
  backgroundColor = EMAIL_CANVAS_BG,
  fontSize,
  lineHeight,
  hideQuotes,
  initialHeight = 200,
  style,
}: Readonly<EmailHtmlViewProps>) {
  const [height, setHeight] = useState(initialHeight);
  // Once the injected probe reports a sane height, it wins over the native
  // content-size callback (which can lag or clamp on iOS).
  const hasProbeHeight = useRef(false);
  const webRef = useRef<WebView>(null);
  // The inline document's own bootstrap may use data:/file:/applewebdata:
  // URLs; once it has loaded, those schemes only come from links in the mail.
  const initialLoadDone = useRef(false);
  const documentHtml = buildEmailDocument(html, {
    textColor,
    backgroundColor,
    fontSize,
    lineHeight,
    hideQuotes,
  });

  // New message ⇒ forget the previous probe lock, otherwise a collapsed height
  // from a bad early measurement sticks across opens.
  useEffect(() => {
    hasProbeHeight.current = false;
    initialLoadDone.current = false;
    setHeight(initialHeight);
  }, [html, initialHeight]);

  const onProbeMessage = (e: WebViewMessageEvent) => {
    const h = Number.parseInt(e.nativeEvent.data, 10);
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
    <View
      style={{
        width: '100%',
        maxWidth: '100%',
        overflow: 'hidden',
        alignSelf: 'stretch',
        backgroundColor,
      }}
    >
      <WebView
        ref={webRef}
        // Docs: html sources require originWhitelist=['*']. Navigation is still
        // gated below — this only lets the engine bootstrap the inline doc.
        originWhitelist={['*']}
        source={{ html: documentHtml, baseUrl: INLINE_BASE_URL }}
        style={[style, { height, width: '100%', alignSelf: 'stretch', backgroundColor }]}
        javaScriptEnabled
        injectedJavaScript={EMAIL_LAYOUT_PROBE}
        onMessage={onProbeMessage}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        // iOS may kill the content process under memory pressure → blank pane.
        onContentProcessDidTerminate={() => {
          // The reload re-runs the document bootstrap, which must be allowed.
          initialLoadDone.current = false;
          webRef.current?.reload();
        }}
        onShouldStartLoadWithRequest={(req) => {
          const url = req.url || '';
          if (isInlineDocumentLoad(url, initialLoadDone.current)) return true;
          // Real web links → system browser; never navigate in-frame.
          if (/^https?:\/\//i.test(url)) {
            Linking.openURL(url).catch(() => {});
            return false;
          }
          // Mail and phone links hand off to the OS (mail app / dialer).
          if (/^(mailto|tel):/i.test(url)) {
            Linking.openURL(url).catch(() => {});
            return false;
          }
          // javascript:, vbscript:, data:, custom schemes, etc.
          return false;
        }}
        onLoadEnd={() => {
          initialLoadDone.current = true;
        }}
        onContentSizeChange={(e) => {
          if (hasProbeHeight.current) return;
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
