package com.weldsuite.weldmail

import android.app.Application
import android.app.NotificationManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.weldsuite.weldmail.offline.Connectivity
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.AppIdentity
import org.weldsuite.core.SessionState
import org.weldsuite.push.FcmOptions
import org.weldsuite.push.PushChannel
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference

class WeldMailApplication : Application() {
    lateinit var env: AppEnvironment
        private set

    lateinit var appearance: AppearancePreference
        private set

    lateinit var store: MailStore
        private set

    lateinit var attachments: Attachments
        private set

    /** The email on screen, so a push about it shows no notification. */
    @Volatile var openEmailId: String? = null

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
        val connectivity = Connectivity(this)
        store = MailStore(this, env, MailRepository(env), connectivity)
        attachments = Attachments(this, env)
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
        // A new email while it's the one open shows no notification; the screen reloads.
        WeldPush.shouldShow = { payload ->
            val emailId = MailLogic.notificationTarget(payload.values)?.emailId
            emailId == null || emailId != openEmailId
        }
        env.scope.launch {
            // Signed out: nothing of this person's mail stays on the phone.
            env.state.drop(1).filter { it is SessionState.SignedOut }.collect { store.clear() }
        }
        env.scope.launch {
            // Back online: what waited in the outbox goes out.
            connectivity.online.drop(1).filter { it }.collect { store.flush() }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                env.scope.launch {
                    store.flush()
                    store.refresh()
                }
            }
        })
    }
}
