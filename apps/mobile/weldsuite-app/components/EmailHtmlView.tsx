import React, { useState } from 'react';
import { Linking, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildEmailDocument, type EmailDocumentOptions } from '@/utils/email-html';

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
 * Email bodies are fully attacker-controlled, so this component:
 *  - disables JavaScript entirely (`javaScriptEnabled={false}`) — the primary
 *    guarantee: no <script>, inline handler, or javascript: URI can execute;
 *  - blocks all in-frame navigation and opens real web links in the system
 *    browser instead (so a malicious body can't redirect/phish in-place);
 *  - constrains origins and disables file access, link previews, multiple
 *    windows and mixed (cleartext) content;
 *  - renders a sanitized body wrapped in a strict Content-Security-Policy
 *    (see utils/email-html).
 *
 * Height is measured natively via `onContentSizeChange` (no JS bridge needed).
 *
 * NOTE: mirrors the identical component in `weldmail-app` — keep them in sync.
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
  const document = buildEmailDocument(html, { textColor, fontSize, lineHeight, hideQuotes });

  return (
    <WebView
      source={{ html: document }}
      style={[style, { height }]}
      // Only the inline document (about:blank / data:) may load in-frame.
      originWhitelist={['about:*', 'data:*']}
      javaScriptEnabled={false}
      scrollEnabled={false}
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
        // `contentSize` is present at runtime but not in react-native-webview's
        // WebViewNativeEvent type, so narrow it explicitly rather than cast to any.
        const contentSize = (e.nativeEvent as { contentSize?: { height: number } }).contentSize;
        const h = contentSize ? Math.ceil(contentSize.height) : 0;
        if (h > 0) setHeight(h);
      }}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
    />
  );
}
