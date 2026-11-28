package com.weldsuite.weldbooks

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.ui.WeldBooksApp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppBranding
import org.weldsuite.ui.SessionGate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WeldTheme

/** `weldbooks://invoice/<id>`, `weldbooks://bill/<id>`, `weldbooks://scan`, … waiting for the app to open them. */
object DeepLinks {
    private val route = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = route.asStateFlow()

    fun take(): String? = route.value.also { route.value = null }

    fun handle(uri: Uri?) {
        routeFor(uri?.host, uri?.pathSegments.orEmpty())?.let { route.value = it }
    }

    /** The screen a link opens, as the Expo app's routes named them. */
    fun routeFor(host: String?, segments: List<String>): String? {
        val first = segments.firstOrNull()
        return when (host) {
            "invoice", "invoices" -> when (first) {
                null -> "invoices"
                "new" -> "invoice/new"
                else -> "invoice/$first"
            }
            "bill" -> when (first) {
                null, "new" -> "bill/new?documentId=&receipt=&receiptType="
                else -> "bill/$first"
            }
            "expense" -> "expense/quick?documentId=&receipt=&receiptType="
            "expenses" -> "expenses"
            "scan" -> "scan"
            "bank" -> first?.let { "bank/$it" } ?: "bank"
            "reconciliation" -> "reconciliation"
            "reports" -> when (first) {
                "profit-loss" -> "reports/profit-loss"
                "balance-sheet" -> "reports/balance-sheet"
                else -> "reports"
            }
            "vat" -> first?.let { "vat/$it" } ?: "vat"
            "contacts" -> when (first) {
                null -> "contacts"
                "new" -> "contacts/new"
                else -> "contacts/$first"
            }
            "settings" -> "settings"
            else -> null
        }
    }
}

/** The one activity. A FragmentActivity, because the biometric prompt needs one. */
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WeldPush.handleIntent(intent)
        DeepLinks.handle(intent?.data)
        val application = application as WeldBooksApplication
        val branding = AppBranding(
            name = getString(R.string.weldbooks_app_name),
            subtitle = getString(R.string.weldbooks_auth_subtitle),
            logo = R.drawable.weldbooks_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldBooksApp(env = application.env, session = ready, appearance = application.appearance)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
        DeepLinks.handle(intent.data)
    }
}
