package com.weldsuite.weldchat

import android.app.Application
import android.app.NotificationManager
import com.weldsuite.weldchat.calls.CallManager
import com.weldsuite.weldchat.calls.CallRinging
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.AppIdentity
import org.weldsuite.push.FcmOptions
import org.weldsuite.push.PushChannel
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference

class WeldChatApplication : Application() {
    lateinit var env: AppEnvironment
        private set

    lateinit var appearance: AppearancePreference
        private set

    /** Home's and the DM list's shared lists, and every chat endpoint. */
    lateinit var store: ChatStore
        private set

    /** The call ring and the calls (ADR CHAT-005, CHAT-008). */
    lateinit var calls: CallManager
        private set

    override fun onCreate() {
        super.onCreate()
        env = AppEnvironment(
            context = this,
            app = AppIdentity(
                code = "weldchat",
                name = getString(R.string.weldchat_app_name),
                scheme = "weldchat",
                requiredModules = listOf("chat"),
                euServerUrl = BuildConfig.EU_SERVER_URL,
                versionName = BuildConfig.VERSION_NAME,
                storeUrl = "https://play.google.com/store/apps/details?id=com.weldsuite.weldchat",
            ),
            lockRequired = false,
            optionalLock = true,
            usesPush = true,
        )
        appearance = AppearancePreference(this, "weldchat")
        store = ChatStore(env, ChatRepository(env) { dmTexts() })
        WeldPush.init(
            context = this,
            env = env,
            options = FcmOptions(BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID),
            launchActivity = MainActivity::class.java,
            smallIcon = R.drawable.ic_notification,
            channels = listOf(
                PushChannel("chat", getString(R.string.weldchat_app_name), NotificationManager.IMPORTANCE_HIGH),
            ),
        )
        calls = CallManager(this, env)
        CallRinging.install(this, env)
    }

    /** The names a DM falls back to, in the app's current language. */
    private fun dmTexts() = DmTexts(
        unknownMember = getString(R.string.weldchat_dms_unknown_member),
        groupFallback = getString(R.string.weldchat_dms_group_fallback),
        fallbackName = getString(R.string.weldchat_dms_fallback_name),
    )
}
