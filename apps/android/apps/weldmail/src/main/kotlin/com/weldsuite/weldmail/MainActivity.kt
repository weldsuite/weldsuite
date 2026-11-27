package com.weldsuite.weldmail

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.ui.WeldMailApp
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppBranding
import org.weldsuite.ui.SessionGate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WeldTheme

/** The one activity. A FragmentActivity, because the biometric prompt needs one. */
class MainActivity : FragmentActivity() {
    /** A weldmail:// link the app was opened with, until the app has followed it. */
    private var deepLink by mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WeldPush.handleIntent(intent)
        deepLink = linkOf(intent)
        val application = application as WeldMailApplication
        val branding = AppBranding(
            name = getString(R.string.weldmail_app_name),
            subtitle = getString(R.string.weldmail_auth_subtitle),
            logo = R.drawable.weldmail_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(brand = Tokens.Brand.weldmail, dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldMailApp(
                        env = application.env,
                        store = application.store,
                        attachments = application.attachments,
                        session = ready,
                        appearance = application.appearance,
                        deepLink = deepLink,
                        onDeepLinkTaken = { deepLink = null },
                        onOpenEmail = { application.openEmailId = it },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
        linkOf(intent)?.let { deepLink = it }
    }

    private fun linkOf(intent: Intent?): Uri? = intent?.data?.takeIf { it.scheme == "weldmail" && it.host != "sso-callback" }
}
