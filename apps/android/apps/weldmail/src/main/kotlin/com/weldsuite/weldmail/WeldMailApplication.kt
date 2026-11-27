package com.weldsuite.weldmail

import android.app.Application
import android.app.NotificationManager
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.AppIdentity
import org.weldsuite.push.FcmOptions
import org.weldsuite.push.PushChannel
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference

class WeldMailApplication : Application() {
    lateinit var env: AppEnvironment
        private set

    lateinit var appearance: AppearancePreference
        private set

    override fun onCreate() {
        super.onCreate()
        env = AppEnvironment(
            context = this,
            app = AppIdentity(
                code = "weldmail",
                name = getString(R.string.weldmail_app_name),
                scheme = "weldmail",
                requiredModules = listOf("mail"),
                euServerUrl = BuildConfig.EU_SERVER_URL,
                versionName = BuildConfig.VERSION_NAME,
                storeUrl = "https://play.google.com/store/apps/details?id=com.weldsuite.weldmail",
            ),
            lockRequired = false,
            optionalLock = true,
            usesPush = true,
        )
        appearance = AppearancePreference(this, "weldmail")
        WeldPush.init(
            context = this,
            env = env,
            options = FcmOptions(BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID),
            launchActivity = MainActivity::class.java,
            smallIcon = R.drawable.ic_notification,
            channels = listOf(
                PushChannel("email", getString(R.string.weldmail_app_name), NotificationManager.IMPORTANCE_HIGH),
            ),
        )
    }
}
