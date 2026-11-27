package com.weldsuite.weldcalendar

import android.app.Application
import android.app.NotificationManager
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.AppIdentity
import org.weldsuite.push.FcmOptions
import org.weldsuite.push.PushChannel
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference

class WeldCalendarApplication : Application() {
    lateinit var env: AppEnvironment
        private set

    lateinit var appearance: AppearancePreference
        private set

    lateinit var calendars: CalendarRepository
        private set

    override fun onCreate() {
        super.onCreate()
        env = AppEnvironment(
            context = this,
            app = AppIdentity(
                code = "weldcalendar",
                name = getString(R.string.weldcalendar_app_name),
                scheme = "weldcalendar",
                requiredModules = listOf("calendar"),
                euServerUrl = BuildConfig.EU_SERVER_URL,
                versionName = BuildConfig.VERSION_NAME,
                storeUrl = "https://play.google.com/store/apps/details?id=com.weldsuite.weldcalendar",
            ),
            lockRequired = false,
            optionalLock = true,
            usesPush = true,
        )
        appearance = AppearancePreference(this, "weldcalendar")
        calendars = CalendarRepository(env, this)
        WeldPush.init(
            context = this,
            env = env,
            options = FcmOptions(BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID),
            launchActivity = MainActivity::class.java,
            smallIcon = R.drawable.ic_notification,
            channels = listOf(
                PushChannel("weldcalendar", getString(R.string.weldcalendar_app_name), NotificationManager.IMPORTANCE_DEFAULT),
            ),
        )
    }
}
