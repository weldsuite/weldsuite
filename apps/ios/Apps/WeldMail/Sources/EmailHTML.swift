import Foundation

/// Received email HTML as the message screen shows it, in a web view, as the
/// Expo app (`utils/email-html.ts`) and the Android app (`EmailHtml.kt`) do.
///
/// Email bodies are written by strangers. The hard guarantees come from the
/// web view (the page's own JavaScript is off, no cookies or storage are
/// kept, links never load in the frame; see `EmailWebView.swift`) and from
/// the Content-Security-Policy put around the body here: no `script-src`;
/// images, fonts and media over https only (tracking pixels sized 1×1 are
/// hidden). `sanitize` strips the obvious dangerous nodes as a second layer,
/// not the only one.
///
/// The message always sits on a white canvas with dark text, also in dark
/// mode: emails are written for that.
enum EmailHTML {
    private static let csp =
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; media-src https: data:;"

    /// Where the inline document is loaded; links resolve against it and are never followed in the frame.
    static let baseURL = URL(string: "https://email.local/")

    private static func replace(_ text: String, _ pattern: String, _ template: String, dotAll: Bool = false) -> String {
        var options: NSRegularExpression.Options = [.caseInsensitive]
        if dotAll { options.insert(.dotMatchesLineSeparators) }
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func firstMatch(_ text: String, _ pattern: String, dotAll: Bool = false) -> [String]? {
        var options: NSRegularExpression.Options = [.caseInsensitive]
        if dotAll { options.insert(.dotMatchesLineSeparators) }
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }
        return (0..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
        }
    }

    /// Strips script, frames, forms, event handlers and `javascript:` links.
    static func sanitize(_ html: String) -> String {
        if html.isEmpty { return "" }
        var out = html
        out = replace(out, #"<script\b[^>]*>.*?</script\s*>"#, "", dotAll: true)
        out = replace(out, #"<iframe\b[^>]*>.*?</iframe\s*>"#, "", dotAll: true)
        out = replace(out, #"<noscript\b[^>]*>.*?</noscript\s*>"#, "", dotAll: true)
        out = replace(out, #"<svg\b[^>]*>.*?</svg\s*>"#, "", dotAll: true)
        out = replace(out, #"</?(?:object|embed|frame|frameset|base|form|input|button|meta|link|applet)\b[^>]*>"#, "")
        out = replace(out, #"\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#, "")
        out = replace(out, #"((?:href|src|xlink:href|action|formaction)\s*=(?:\s*["'])?)\s*(?:javascript|vbscript)\s*:"#, "$1#")
        out = replace(out, #"((?:href|src|xlink:href)\s*=(?:\s*["'])?)\s*data\s*:\s*text/html"#, "$1#")
        return out
    }

    /// Empty blocks, `<br>`s and spaces at the end: they only add height under the text.
    static func trimTrailingEmpty(_ html: String) -> String {
        var out = html
        while true {
            let next = stripTrailingUnit(out)
            if next == out { return out }
            out = next
        }
    }

    private static func stripTrailingUnit(_ html: String) -> String {
        var trimmed = html
        while let last = trimmed.last, last.isWhitespace { trimmed.removeLast() }
        if trimmed.count != html.count { return trimmed }
        let tail = html.suffix(6).lowercased()
        if tail == "&nbsp;" || tail == "&#160;" { return String(html.dropLast(6)) }
        let noBreak = replace(html, #"<br\s*/?>$"#, "")
        return replace(noBreak, #"<(p|div|span|o:p)\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*/?>)*</\1\s*>$"#, "")
    }

    /// A whole HTML document: its `<style>` blocks and body (with the body's bgcolor and style) kept.
    static func unwrap(_ html: String) -> String {
        if html.isEmpty { return "" }
        let head = firstMatch(html, #"<head\b[^>]*>(.*?)</head>"#, dotAll: true)
        let body = firstMatch(html, #"<body\b([^>]*)>(.*?)</body>"#, dotAll: true)
        if head == nil && body == nil { return html }
        var styles = ""
        if let headContent = head?[1],
           let regex = try? NSRegularExpression(pattern: #"<style\b[^>]*>.*?</style\s*>"#, options: [.caseInsensitive, .dotMatchesLineSeparators]) {
            let matches = regex.matches(in: headContent, range: NSRange(headContent.startIndex..., in: headContent))
            styles = matches.compactMap { Range($0.range, in: headContent).map { String(headContent[$0]) } }.joined()
        }
        let content = body?[2] ?? html
        let attributes = body?[1] ?? ""
        let style = firstMatch(attributes, #"\sstyle\s*=\s*("[^"]*"|'[^']*')"#)?[1]
        let background = firstMatch(attributes, #"\sbgcolor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#)?[1]
        if style == nil && background == nil { return styles + content }
        var open = "<div"
        if let background { open += " bgcolor=\(background)" }
        if let style { open += " style=\(style)" }
        open += ">"
        return "\(styles)\(open)\(content)</div>"
    }

    /// Fixed-width email layouts reflow on a phone; quotes can be hidden.
    static func css(fontSize: Int, lineHeight: Double, hideQuotes: Bool) -> String {
        let quotes = hideQuotes ? ".gmail_quote,.yahoo_quoted{display:none;}blockquote{display:none;}" : ""
        return "html{color-scheme:light only;supported-color-schemes:light;}"
            + "html,body{width:100% !important;max-width:100% !important;overflow-x:auto !important;"
            + "margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:#ffffff !important;}"
            + "body{font-family:system-ui,-apple-system,sans-serif;font-size:\(fontSize)px;line-height:\(lineHeight);"
            + "color:#1a1a1a;word-wrap:break-word;overflow-wrap:anywhere;}"
            + "table,td,th,div,center,section,article{max-width:100% !important;min-width:0 !important;}"
            + "table{border-collapse:collapse;}"
            + "td,th{word-wrap:break-word !important;overflow-wrap:anywhere !important;}"
            + "img,video{max-width:100% !important;height:auto !important;}"
            + "pre,code{white-space:pre-wrap !important;word-wrap:break-word !important;}"
            + "a{color:#3B82F6;}"
            + "img[width=\"1\"],img[height=\"1\"]{display:none !important;}"
            + quotes
    }

    /// The sanitized, CSP-protected document the web view loads.
    static func document(_ html: String, fontSize: Int = 15, lineHeight: Double = 1.6, hideQuotes: Bool = false) -> String {
        let body = trimTrailingEmpty(sanitize(unwrap(html)))
        return "<!DOCTYPE html><html><head>"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">"
            + "<meta name=\"color-scheme\" content=\"light only\">"
            + "<meta name=\"supported-color-schemes\" content=\"light\">"
            + "<meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\">"
            + "<style>\(css(fontSize: fontSize, lineHeight: lineHeight, hideQuotes: hideQuotes))</style>"
            + "</head><body>\(body)</body></html>"
    }

    /// Whether a navigation is the inline document loading (or jumping to an
    /// anchor in it) rather than a link in the mail. The whole URL must match:
    /// `https://email.local@evil.com/` is another host. The bootstrap schemes
    /// pass only until the document has loaded.
    static func isInlineDocumentLoad(_ url: String, loaded: Bool) -> Bool {
        if url.isEmpty || url == "about:blank" { return true }
        if url.range(of: "^(about|data|applewebdata|file):", options: [.regularExpression, .caseInsensitive]) != nil { return !loaded }
        return url.range(of: "^https://email\\.local/?(#.*)?$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// What a tapped link does: open in the browser, hand to the mail app or dialler, or nothing.
    enum LinkAction: Equatable {
        case browser, system, block
    }

    static func linkAction(_ url: String) -> LinkAction {
        if url.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil { return .browser }
        if url.range(of: "^(mailto|tel):", options: [.regularExpression, .caseInsensitive]) != nil { return .system }
        return .block
    }

    /// Reports the body's height to the app (the `weldMailHeight` handler in
    /// the app's own script world), so the web view sizes to it.
    static let heightProbe = """
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
          if(h>0){window.webkit.messageHandlers.weldMailHeight.postMessage(String(Math.ceil(h)));}
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
