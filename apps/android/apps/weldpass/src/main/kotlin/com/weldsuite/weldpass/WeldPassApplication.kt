package com.weldsuite.weldpass

import android.app.Application
import com.weldsuite.weldpass.offline.OfflineStore
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.AppIdentity

class WeldPassApplication : Application() {
    lateinit var env: AppEnvironment
        private set

    lateinit var passwords: PassRepository
        private set

    override fun onCreate() {
        super.onCreate()
        env = AppEnvironment(
            context = this,
            app = AppIdentity(
                code = "weldpass",
                name = getString(R.string.weldpass_app_name),
                scheme = "weldpass",
                requiredModules = listOf("pass"),
                euServerUrl = BuildConfig.EU_SERVER_URL,
                versionName = BuildConfig.VERSION_NAME,
                storeUrl = "https://play.google.com/store/apps/details?id=com.weldsuite.weldpass",
            ),
            // A password manager is always locked: biometrics or the passcode at start,
            // after a minute in the background, and before a secret is shown or copied.
            lockRequired = true,
        )
        passwords = PassRepository(env, OfflineStore(this, env, BuildConfig.VERSION_NAME))
    }
}
