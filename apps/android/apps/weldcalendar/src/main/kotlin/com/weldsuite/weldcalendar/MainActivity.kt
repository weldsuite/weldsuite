package com.weldsuite.weldcalendar

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.ui.WeldCalendarApp
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppBranding
import org.weldsuite.ui.SessionGate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WeldTheme

/** The one activity. A FragmentActivity, because the biometric prompt needs one. */
class MainActivity : FragmentActivity() {
    /** A `weldcalendar://` link the app hasn't opened yet. */
    private val link = mutableStateOf<CalendarLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WeldPush.handleIntent(intent)
        takeLink(intent)
        val application = application as WeldCalendarApplication
        val branding = AppBranding(
            name = getString(R.string.weldcalendar_app_name),
            subtitle = getString(R.string.weldcalendar_auth_subtitle),
            logo = R.drawable.weldcalendar_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(brand = Tokens.Brand.weldcalendar, dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldCalendarApp(
                        env = application.env,
                        repository = application.calendars,
                        session = ready,
                        appearance = application.appearance,
                        link = link.value,
                        onLinkTaken = { link.value = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
        takeLink(intent)
    }

    private fun takeLink(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        parseCalendarLink(intent.dataString)?.let { link.value = it }
    }
}
