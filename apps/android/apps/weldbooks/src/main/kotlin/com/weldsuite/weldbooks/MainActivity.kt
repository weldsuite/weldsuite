package com.weldsuite.weldbooks

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.ui.WeldBooksApp
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
        WeldPush.handleIntent(intent)
        val application = application as WeldBooksApplication
        val branding = AppBranding(
            name = getString(R.string.weldbooks_app_name),
            subtitle = getString(R.string.weldbooks_auth_subtitle),
            logo = R.drawable.weldbooks_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(brand = Tokens.Brand.weldbooks, dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldBooksApp(env = application.env, session = ready, appearance = application.appearance)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
    }
}
