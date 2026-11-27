package com.weldsuite.weldhr

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.ui.WeldHRApp
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
        val application = application as WeldHRApplication
        val branding = AppBranding(
            name = getString(R.string.weldhr_app_name),
            subtitle = getString(R.string.weldhr_auth_subtitle),
            logo = R.drawable.weldhr_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(brand = Tokens.Brand.weldhr, dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldHRApp(env = application.env, session = ready, appearance = application.appearance)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
    }
}
