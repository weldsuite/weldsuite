import SwiftUI
import WebKit

/// A received message's HTML, read-only, sized to its content (no scrolling
/// of its own: the screen scrolls). The document is `EmailHTML.document`:
/// sanitized, under a Content-Security-Policy without scripts, on a white
/// canvas. The page's own JavaScript is off; only the app's height probe
/// runs, in the app's own script world. Nothing is stored (a non-persistent
/// data store), and a tapped link never loads in the frame: web links open in
/// the browser, `mailto:` and `tel:` in the mail app and dialler, anything
/// else is ignored.
struct EmailWebView: View {
    let html: String
    var fontSize = 15
    var lineHeight = 1.6
    var hideQuotes = false
    var initialHeight: CGFloat = 200

    @State private var height: CGFloat?

    var body: some View {
        EmailWebViewRepresentable(
            document: EmailHTML.document(html, fontSize: fontSize, lineHeight: lineHeight, hideQuotes: hideQuotes),
            height: $height
        )
        .frame(height: height ?? initialHeight)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("email-body")
    }
}

private struct EmailWebViewRepresentable: UIViewRepresentable {
    let document: String
    @Binding var height: CGFloat?

    func makeCoordinator() -> EmailWebCoordinator {
        EmailWebCoordinator(height: $height)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.dataDetectorTypes = []
        let controller = WKUserContentController()
        controller.add(context.coordinator, contentWorld: .defaultClient, name: "weldMailHeight")
        controller.addUserScript(WKUserScript(source: EmailHTML.heightProbe, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.isOpaque = true
        view.backgroundColor = .white
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.height = $height
        guard context.coordinator.document != document else { return }
        context.coordinator.document = document
        context.coordinator.loaded = false
        view.loadHTMLString(document, baseURL: EmailHTML.baseURL)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: EmailWebCoordinator) {
        view.configuration.userContentController.removeAllScriptMessageHandlers()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }
}

@MainActor
final class EmailWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var height: Binding<CGFloat?>
    var document: String?
    /// The inline document has loaded: from now on the bootstrap schemes can only be links.
    var loaded = false

    init(height: Binding<CGFloat?>) {
        self.height = height
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Near-zero heights come from a probe that ran before layout; they'd hide the body.
        guard let text = message.body as? String, let value = Double(text), value >= 40, value < 100_000 else { return }
        if height.wrappedValue != CGFloat(value) { height.wrappedValue = CGFloat(value) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url?.absoluteString ?? ""
        if EmailHTML.isInlineDocumentLoad(url, loaded: loaded) { return .allow }
        if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame?.isMainFrame != false {
            follow(url)
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
    }

    /// `target="_blank"`: never a new web view; the link opens outside the app.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url?.absoluteString { follow(url) }
        return nil
    }

    private func follow(_ url: String) {
        switch EmailHTML.linkAction(url) {
        case .browser, .system: openExternal(url)
        case .block: break
        }
    }
}
