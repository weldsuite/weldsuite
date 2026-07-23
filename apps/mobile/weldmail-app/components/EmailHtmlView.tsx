import React, { useRef, useState } from 'react';
import { Linking, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { buildEmailDocument, type EmailDocumentOptions } from '@/utils/email-html';

interface EmailHtmlViewProps extends EmailDocumentOptions {
  /** Raw (untrusted) email HTML body. */
  html: string;
  /** Initial height before the content reports its real size. */
  initialHeight?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Host-injected script that measures the rendered document height and posts it
 * back to React Native. It runs as a react-native-webview *user script*, which
 * is injected by the native layer (WKUserScript / evaluateJavascript) and is
 * therefore exempt from the page's `default-src 'none'` CSP — while the email's
 * OWN scripts stay blocked by that same CSP (see utils/email-html). It only
 * reads layout and calls `postMessage`; it never touches page content.
 *
 * Re-measures on load, on window resize, as each image finishes loading, via a
 * ResizeObserver, and on a couple of delayed ticks — the usual causes of an
 * initially-wrong height (late images/fonts) all trigger a fresh report.
 */
const HEIGHT_REPORTER = `
(function(){
  function report(){
    try{
      var b=document.body, e=document.documentElement;
      var h=Math.max(
        b?b.scrollHeight:0, b?b.offsetHeight:0,
        e?e.scrollHeight:0, e?e.offsetHeight:0
      );
      if(h>0 && window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(String(Math.ceil(h))); }
    }catch(_){}
  }
  report();
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  var imgs=document.images||[];
  for(var i=0;i<imgs.length;i++){
    var im=imgs[i];
    if(im && !im.complete){ im.addEventListener('load', report); im.addEventListener('error', report); }
  }
  try{ if(window.ResizeObserver && document.body){ new ResizeObserver(report).observe(document.body); } }catch(_){}
  setTimeout(report, 300);
  setTimeout(report, 1000);
})();
true;
`;

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
 * JavaScript is enabled ONLY so the host-injected HEIGHT_REPORTER can measure
 * the content height (`javaScriptEnabled={false}` makes iOS never fire
 * `onContentSizeChange`, freezing the body at `initialHeight`). The page's own
 * scripts remain blocked by the CSP above, so enabling the engine does not let
 * attacker code run. Height is authoritative from the injected probe, with
 * native `onContentSizeChange` as a fallback until the first probe arrives.
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
  // Once the injected probe reports, it wins over the native content-size
  // callback (which can lag or clamp on iOS).
  const hasProbeHeight = useRef(false);
  const document = buildEmailDocument(html, { textColor, fontSize, lineHeight, hideQuotes });

  const onProbeMessage = (e: WebViewMessageEvent) => {
    const h = parseInt(e.nativeEvent.data, 10);
    // Only trust a sane, positive measurement from our own probe.
    if (Number.isFinite(h) && h > 0 && h < 100000) {
      hasProbeHeight.current = true;
      setHeight(h);
    }
  };

  return (
    <WebView
      source={{ html: document }}
      style={[style, { height }]}
      // Only the inline document (about:blank / data:) may load in-frame.
      originWhitelist={['about:*', 'data:*']}
      // Engine on strictly for the host-injected height probe; the email's own
      // scripts are blocked by the document CSP (default-src 'none').
      javaScriptEnabled
      injectedJavaScript={HEIGHT_REPORTER}
      onMessage={onProbeMessage}
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
        // Fallback only: the injected probe is authoritative once it reports.
        if (hasProbeHeight.current) return;
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
