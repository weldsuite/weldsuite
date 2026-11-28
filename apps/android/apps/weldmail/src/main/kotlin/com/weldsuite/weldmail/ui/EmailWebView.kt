package com.weldsuite.weldmail.ui

import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.weldsuite.weldmail.EmailHtml
import org.weldsuite.ui.tagged

/**
 * A received message's HTML, read-only, sized to its content (no scrolling
 * of its own: the screen scrolls). The document is [EmailHtml.document]:
 * sanitized, under a Content-Security-Policy without scripts, on a white
 * canvas. JavaScript runs only for the app's own height probe; the page can't
 * open windows or read files, and a tapped link never loads in the frame:
 * web links open in the browser, `mailto:` and `tel:` in the mail app and
 * dialler, anything else is ignored.
 */
@Composable
fun EmailWebView(html: String, modifier: Modifier = Modifier, fontSize: Int = 15, lineHeight: Double = 1.6, hideQuotes: Boolean = false, initialHeight: Int = 200) {
    val context = LocalContext.current
    var height by remember(html) { mutableIntStateOf(initialHeight) }
    val document = remember(html, fontSize, lineHeight, hideQuotes) { EmailHtml.document(html, fontSize, lineHeight, hideQuotes) }
    val client = remember(context) {
        MailWebViewClient(onLink = { url ->
            when (EmailHtml.linkAction(url)) {
                EmailHtml.LinkAction.BROWSER, EmailHtml.LinkAction.SYSTEM -> openExternal(context, url)
                EmailHtml.LinkAction.BLOCK -> {}
            }
        })
    }
    AndroidView(
        modifier = modifier.fillMaxWidth().height(height.dp).tagged("email-body"),
        factory = { viewContext ->
            WebView(viewContext).apply {
                setBackgroundColor(AndroidColor.WHITE)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                settings.apply {
                    javaScriptEnabled = true
                    allowFileAccess = false
                    allowContentAccess = false
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    loadWithOverviewMode = false
                    useWideViewPort = false
                    setGeolocationEnabled(false)
                }
                addJavascriptInterface(HeightBridge { reported -> height = reported }, "WeldMailHeight")
                webViewClient = client
            }
        },
        update = { view ->
            if (view.tag != document) {
                view.tag = document
                client.loaded = false
                view.loadDataWithBaseURL(EmailHtml.BASE_URL, document, "text/html", "utf-8", null)
            }
        },
    )
}

/** The probe's height, in CSS pixels (dp), handed to the main thread. */
private class HeightBridge(private val onHeight: (Int) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun report(value: String) {
        val height = value.toIntOrNull() ?: return
        // Near-zero heights come from a probe that ran before layout; they'd hide the body.
        if (height in 40..99_999) main.post { onHeight(height) }
    }
}

private class MailWebViewClient(private val onLink: (String) -> Unit) : WebViewClient() {
    /** The inline document has loaded: from now on the bootstrap schemes can only be links. */
    var loaded = false

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (EmailHtml.isInlineDocumentLoad(url, loaded)) return false
        if (request.hasGesture() || request.isForMainFrame) onLink(url)
        return true
    }

    override fun onPageFinished(view: WebView, url: String?) {
        loaded = true
        view.evaluateJavascript(EmailHtml.HEIGHT_PROBE, null)
    }

    /** The renderer died (memory): the app carries on, the pane stays blank until reopened. */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.O)
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
        view.tag = null
        return true
    }
}
