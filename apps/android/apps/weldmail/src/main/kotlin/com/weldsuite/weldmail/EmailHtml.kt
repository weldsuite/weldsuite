package com.weldsuite.weldmail

/**
 * Received email HTML as the message screen shows it, in a WebView, as the
 * Expo app (`utils/email-html.ts`) and the web's isolated reader do.
 *
 * Email bodies are written by strangers. The hard guarantees come from the
 * WebView (no file access, links never load in the frame, see
 * `ui/EmailWebView.kt`) and from the Content-Security-Policy put around the
 * body here: no `script-src`, so the mail's own scripts never run;
 * images, fonts and media load over https only (remote images load, as in the
 * Expo app; tracking pixels sized 1×1 are hidden). [sanitize] strips the
 * obvious dangerous nodes as a second layer, not the only one.
 *
 * The message always sits on a white canvas with dark text, also in dark
 * mode: emails are written for that.
 */
object EmailHtml {
    private const val CSP =
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; media-src https: data:;"

    /** Where the inline document is loaded; links resolve against it and are never followed in the frame. */
    const val BASE_URL = "https://email.local/"

    const val CANVAS_BACKGROUND = "#ffffff"
    const val CANVAS_TEXT = "#1a1a1a"

    private val INLINE_DOCUMENT = Regex("^https://email\\.local/?(#.*)?$", RegexOption.IGNORE_CASE)
    private val BOOTSTRAP = Regex("^(about|data|applewebdata|file):", RegexOption.IGNORE_CASE)

    /** Strips script, frames, forms, event handlers and `javascript:` links. */
    fun sanitize(html: String): String {
        if (html.isEmpty()) return ""
        val ci = setOf(RegexOption.IGNORE_CASE)
        val block = setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
        return html
            .replace(Regex("<script\\b[^>]*>.*?</script\\s*>", block), "")
            .replace(Regex("<iframe\\b[^>]*>.*?</iframe\\s*>", block), "")
            .replace(Regex("<noscript\\b[^>]*>.*?</noscript\\s*>", block), "")
            .replace(Regex("<svg\\b[^>]*>.*?</svg\\s*>", block), "")
            .replace(Regex("</?(?:object|embed|frame|frameset|base|form|input|button|meta|link|applet)\\b[^>]*>", ci), "")
            .replace(Regex("\\son[a-z]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", ci), "")
            .replace(Regex("((?:href|src|xlink:href|action|formaction)\\s*=(?:\\s*[\"'])?)\\s*(?:javascript|vbscript)\\s*:", ci), "$1#")
            .replace(Regex("((?:href|src|xlink:href)\\s*=(?:\\s*[\"'])?)\\s*data\\s*:\\s*text/html", ci), "$1#")
    }

    private val TRAILING_BR = Regex("<br\\s*/?>$", RegexOption.IGNORE_CASE)
    private val TRAILING_EMPTY_BLOCK =
        Regex("<(p|div|span|o:p)\\b[^>]*>(?:\\s|&nbsp;|&#160;|<br\\s*/?>)*</\\1\\s*>$", RegexOption.IGNORE_CASE)

    /** Empty blocks, `<br>`s and spaces at the end: they only add height under the text. */
    fun trimTrailingEmpty(html: String): String {
        var out = html
        while (true) {
            val next = stripTrailingUnit(out)
            if (next == out) return out
            out = next
        }
    }

    private fun stripTrailingUnit(html: String): String {
        val trimmed = html.trimEnd()
        if (trimmed.length != html.length) return trimmed
        val tail = html.takeLast(6).lowercase()
        if (tail == "&nbsp;" || tail == "&#160;") return html.dropLast(6)
        return html.replace(TRAILING_BR, "").replace(TRAILING_EMPTY_BLOCK, "")
    }

    /** A whole HTML document: its `<style>` blocks and body (with the body's bgcolor and style) kept. */
    fun unwrap(html: String): String {
        if (html.isEmpty()) return ""
        val opts = setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
        val head = Regex("<head\\b[^>]*>(.*?)</head>", opts).find(html)
        val body = Regex("<body\\b([^>]*)>(.*?)</body>", opts).find(html)
        if (head == null && body == null) return html
        val styles = head?.let { Regex("<style\\b[^>]*>.*?</style\\s*>", opts).findAll(it.groupValues[1]).joinToString("") { m -> m.value } }.orEmpty()
        val content = body?.groupValues?.get(2) ?: html
        val attrs = body?.groupValues?.get(1).orEmpty()
        val style = Regex("\\sstyle\\s*=\\s*(\"[^\"]*\"|'[^']*')", RegexOption.IGNORE_CASE).find(attrs)?.groupValues?.get(1)
        val bg = Regex("\\sbgcolor\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE).find(attrs)?.groupValues?.get(1)
        if (style == null && bg == null) return styles + content
        val open = "<div" + (bg?.let { " bgcolor=$it" } ?: "") + (style?.let { " style=$it" } ?: "") + ">"
        return "$styles$open$content</div>"
    }

    /** Fixed-width email layouts reflow on a phone; quotes can be hidden. */
    fun css(fontSize: Int, lineHeight: Double, hideQuotes: Boolean): String {
        val quotes = if (hideQuotes) ".gmail_quote,.yahoo_quoted{display:none;}blockquote{display:none;}" else ""
        return "html{color-scheme:light only;supported-color-schemes:light;}" +
            "html,body{width:100% !important;max-width:100% !important;overflow-x:auto !important;" +
            "margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:$CANVAS_BACKGROUND !important;}" +
            "body{font-family:system-ui,-apple-system,sans-serif;font-size:${fontSize}px;line-height:$lineHeight;" +
            "color:$CANVAS_TEXT;word-wrap:break-word;overflow-wrap:anywhere;}" +
            "table,td,th,div,center,section,article{max-width:100% !important;min-width:0 !important;}" +
            "table{border-collapse:collapse;}" +
            "td,th{word-wrap:break-word !important;overflow-wrap:anywhere !important;}" +
            "img,video{max-width:100% !important;height:auto !important;}" +
            "pre,code{white-space:pre-wrap !important;word-wrap:break-word !important;}" +
            "a{color:#3B82F6;}" +
            "img[width=\"1\"],img[height=\"1\"]{display:none !important;}" +
            quotes
    }

    /** The sanitized, CSP-protected document the WebView loads. */
    fun document(html: String, fontSize: Int = 15, lineHeight: Double = 1.6, hideQuotes: Boolean = false): String {
        val body = trimTrailingEmpty(sanitize(unwrap(html)))
        return "<!DOCTYPE html><html><head>" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">" +
            "<meta name=\"color-scheme\" content=\"light only\">" +
            "<meta name=\"supported-color-schemes\" content=\"light\">" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">" +
            "<style>${css(fontSize, lineHeight, hideQuotes)}</style>" +
            "</head><body>$body</body></html>"
    }

    /** Plain text as a document of its own, so a text-only message reads the same way. */
    fun plainDocument(text: String, fontSize: Int = 15): String =
        document("<div style=\"white-space:pre-wrap\">${MailLogic.escapeHtml(text)}</div>", fontSize)

    /**
     * Whether a navigation is the inline document loading (or jumping to an
     * anchor in it) rather than a link in the mail. The whole URL must match:
     * `https://email.local@evil.com/` is another host. The bootstrap schemes
     * pass only until the document has loaded.
     */
    fun isInlineDocumentLoad(url: String, loaded: Boolean): Boolean {
        if (url.isEmpty() || url == "about:blank") return true
        if (BOOTSTRAP.containsMatchIn(url)) return !loaded
        return INLINE_DOCUMENT.matches(url)
    }

    /** What a tapped link does: open in the browser, hand to the mail app or dialler, or nothing. */
    enum class LinkAction { BROWSER, SYSTEM, BLOCK }

    fun linkAction(url: String): LinkAction = when {
        Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url) -> LinkAction.BROWSER
        Regex("^(mailto|tel):", RegexOption.IGNORE_CASE).containsMatchIn(url) -> LinkAction.SYSTEM
        else -> LinkAction.BLOCK
    }

    /** Reports the body's height to the app (`WeldMailHeight.report`), so the WebView sizes to it. */
    const val HEIGHT_PROBE = """
(function(){
  function fit(){
    try{
      var max=document.documentElement.clientWidth||window.innerWidth||0;
      if(!(max>=120)||!document.body) return;
      var nodes=document.body.querySelectorAll('table,td,th,div,center,img,section,article');
      for(var i=0;i<nodes.length;i++){
        var el=nodes[i];
        if(el.hasAttribute('width')){var w=el.getAttribute('width');if(w&&w.indexOf('%')===-1&&parseInt(w,10)>max)el.setAttribute('width','100%');}
        if(el.style){
          if(el.style.width&&/px/i.test(el.style.width)&&parseFloat(el.style.width)>max)el.style.setProperty('width','100%','important');
          if(el.style.minWidth&&/px/i.test(el.style.minWidth)&&parseFloat(el.style.minWidth)>max)el.style.setProperty('min-width','0px','important');
        }
      }
    }catch(_){}
  }
  function report(){
    try{
      fit();
      var b=document.body;var h=b?Math.max(b.scrollHeight,b.offsetHeight):0;
      if(h>0&&window.WeldMailHeight){window.WeldMailHeight.report(String(Math.ceil(h)));}
    }catch(_){}
  }
  report();
  window.addEventListener('load',report);
  window.addEventListener('resize',report);
  var imgs=document.images||[];
  for(var i=0;i<imgs.length;i++){var im=imgs[i];if(im&&!im.complete){im.addEventListener('load',report);im.addEventListener('error',report);}}
  try{if(window.ResizeObserver&&document.body){new ResizeObserver(report).observe(document.body);}}catch(_){}
  setTimeout(report,300);setTimeout(report,1000);
})();
"""
}
