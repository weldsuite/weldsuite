package com.weldsuite.weldchat

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldchat.ui.WeldChatApp
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppBranding
import org.weldsuite.ui.SessionGate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WeldTheme

/** The one activity. A FragmentActivity, because the biometric prompt needs one. */
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val application = application as WeldChatApplication
        handle(intent)
        val branding = AppBranding(
            name = getString(R.string.weldchat_app_name),
            subtitle = getString(R.string.weldchat_auth_subtitle),
            logo = R.drawable.weldchat_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldChatApp(
                        env = application.env,
                        session = ready,
                        appearance = application.appearance,
                        store = application.store,
                        calls = application.calls,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    /** A call notification's Answer or tap, a tapped push, or a weldchat:// link. */
    private fun handle(intent: Intent?) {
        (application as WeldChatApplication).calls.handleIntent(intent)
        WeldPush.handleIntent(intent)
        DeepLinks.offer(intent)
    }
}
