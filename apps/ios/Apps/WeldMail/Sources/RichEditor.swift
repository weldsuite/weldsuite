import SwiftUI
import WebKit

/// Chips that wrap onto the next line when a row is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// The rich editor's state: the HTML, its text, and the formats under the cursor.
@MainActor
@Observable
final class RichEditorModel {
    var html = ""
    var text = ""
    var bold = false
    var italic = false
    var underline = false
    var bullets = false
    var numbers = false
    @ObservationIgnored weak var webView: WKWebView?

    /// Applies a format to the selection (`bold`, `insertUnorderedList`, …).
    func format(_ command: String) {
        let allowed = ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList"]
        guard allowed.contains(command) else { return }
        webView?.evaluateJavaScript("window.weldFormat && window.weldFormat('\(command)');", completionHandler: nil)
    }

    func update(from body: [String: Any]) {
        switch body["type"] as? String {
        case "change":
            html = body["html"] as? String ?? ""
            text = body["text"] as? String ?? ""
        case "formats":
            bold = body["b"] as? Bool ?? false
            italic = body["i"] as? Bool ?? false
            underline = body["u"] as? Bool ?? false
            bullets = body["l"] as? Bool ?? false
            numbers = body["ol"] as? Bool ?? false
        default:
            break
        }
    }
}

/// The body: an editable page (`contenteditable`), as the Expo and Android
/// apps' editors, with formatting from the toolbar. It loads only its own
/// page; nothing pasted into it navigates.
struct RichEditor: UIViewRepresentable {
    let model: RichEditorModel
    let placeholder: String
    let dark: Bool

    func makeCoordinator() -> RichEditorCoordinator {
        RichEditorCoordinator(model: model)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "weldMailEditor")
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        model.webView = view
        view.loadHTMLString(Self.page(textColor: dark ? "#F2F2F7" : "#1A1A1A", placeholder: placeholder), baseURL: URL(string: "https://compose.local/"))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: RichEditorCoordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "weldMailEditor")
        view.navigationDelegate = nil
    }

    static func page(textColor: String, placeholder: String) -> String {
        "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">"
            + "<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:transparent}"
            + "#e{font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.5;color:\(textColor);padding:10px 0;min-height:200px;outline:none;word-wrap:break-word}"
            + "#e:empty:before{content:attr(data-placeholder);color:#9CA3AF;pointer-events:none}#e ul,#e ol{padding-left:20px;margin:4px 0}#e a{color:#3B82F6}</style></head>"
            + "<body><div id=\"e\" contenteditable=\"true\" data-placeholder=\"\(MailLogic.escapeHTML(placeholder))\"></div><script>"
            + "var e=document.getElementById('e');var h=window.webkit.messageHandlers.weldMailEditor;"
            + "function s(){h.postMessage({type:'change',html:e.innerHTML,text:e.innerText})}"
            + "function f(){h.postMessage({type:'formats',b:document.queryCommandState('bold'),i:document.queryCommandState('italic'),u:document.queryCommandState('underline'),l:document.queryCommandState('insertUnorderedList'),ol:document.queryCommandState('insertOrderedList')})}"
            + "e.addEventListener('input',s);document.addEventListener('selectionchange',f);"
            + "window.weldFormat=function(c){e.focus();document.execCommand(c,false,null);f();s()};"
            + "</script></body></html>"
    }
}

@MainActor
final class RichEditorCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let model: RichEditorModel

    init(model: RichEditorModel) {
        self.model = model
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        model.update(from: body)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        let ownPage = url?.host == "compose.local" || url?.absoluteString == "about:blank"
        return ownPage && navigationAction.navigationType != .linkActivated ? .allow : .cancel
    }
}
