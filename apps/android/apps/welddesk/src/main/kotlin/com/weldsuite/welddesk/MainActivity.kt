package com.weldsuite.welddesk

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.welddesk.ui.WeldDeskApp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
        DeskLinks.handle(intent)
        val application = application as WeldDeskApplication
        val branding = AppBranding(
            name = getString(R.string.welddesk_app_name),
            subtitle = getString(R.string.welddesk_auth_subtitle),
            logo = R.drawable.welddesk_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(dark = appearance.isDark(isSystemInDarkTheme())) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldDeskApp(env = application.env, repository = application.repository, session = ready, appearance = application.appearance)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        WeldPush.handleIntent(intent)
        DeskLinks.handle(intent)
    }
}

/** A `welddesk://` link the app was opened with, waiting to be followed once the inbox is on screen. */
object DeskLinks {
    private val links = MutableStateFlow<DeskRoute?>(null)
    val pending: StateFlow<DeskRoute?> = links.asStateFlow()

    fun handle(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        DeskLogic.routeForLink(intent.dataString)?.let { links.value = it }
    }

    /** The waiting link, once. */
    fun take(): DeskRoute? = links.value.also { links.value = null }
}
