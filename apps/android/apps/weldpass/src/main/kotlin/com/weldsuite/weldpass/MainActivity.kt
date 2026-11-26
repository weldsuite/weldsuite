package com.weldsuite.weldpass

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val application = application as WeldPassApplication
        val branding = AppBranding(
            name = getString(R.string.weldpass_app_name),
            subtitle = getString(R.string.weldpass_auth_subtitle),
            logo = R.drawable.weldpass_logo,
        )
        setContent {
            WeldTheme(brand = Tokens.Brand.weldpass) {
                SessionGate(env = application.env, branding = branding) { ready ->
                    WeldPassApp(env = application.env, repository = application.passwords, session = ready)
                }
            }
        }
    }
}
