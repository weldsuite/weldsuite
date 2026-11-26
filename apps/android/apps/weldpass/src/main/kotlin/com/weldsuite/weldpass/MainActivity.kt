package com.weldsuite.weldpass

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.autofill.PendingSave
import com.weldsuite.weldpass.ui.WeldPassApp
import org.weldsuite.ui.AppBranding
import org.weldsuite.ui.SessionGate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WeldTheme

/**
 * The one activity. A FragmentActivity, because the biometric prompt needs
 * one. Screenshots and the app switcher's preview are blocked everywhere: a
 * password manager shows secrets on any screen.
 */
class MainActivity : FragmentActivity() {
    /** A login autofill asked to save, until the "New login" form takes it. */
    private val autofillSave = mutableStateOf<PendingSave.Values?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        takeAutofillSave(intent)
        val application = application as WeldPassApplication
        val branding = AppBranding(
            name = getString(R.string.weldpass_app_name),
            subtitle = getString(R.string.weldpass_auth_subtitle),
            logo = R.drawable.weldpass_logo,
        )
        setContent {
            val appearance by application.appearance.value.collectAsStateWithLifecycle()
            WeldTheme(brand = Tokens.Brand.weldpass, dark = appearance.isDark()) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldPassApp(
                        env = application.env,
                        repository = application.passwords,
                        session = ready,
                        appearance = application.appearance,
                        autofillSave = autofillSave.value,
                        onAutofillSaveTaken = { autofillSave.value = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeAutofillSave(intent)
    }

    private fun takeAutofillSave(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_FROM_AUTOFILL, false) == true) {
            PendingSave.take()?.let { autofillSave.value = it }
        }
    }

    companion object {
        const val EXTRA_FROM_AUTOFILL = "weldpass.fromAutofill"
    }
}
