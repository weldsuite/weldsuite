package org.weldsuite.push

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.push.PushPayload
import org.weldsuite.core.push.PushProvider
import kotlin.coroutines.resume

/** The app's Firebase project, from its build settings. Empty values mean no push in this build. */
data class FcmOptions(val projectId: String, val applicationId: String, val apiKey: String, val senderId: String) {
    val isComplete: Boolean get() = listOf(projectId, applicationId, apiKey, senderId).all { it.isNotBlank() }
}

/** A notification channel the app creates (the server names `chat`, `email`, `incoming_call`, … per category). */
data class PushChannel(val id: String, val name: String, val importance: Int = NotificationManager.IMPORTANCE_DEFAULT)

/**
 * Push for one app process. Call [init] in `Application.onCreate`, and
 * [handleIntent] from the activity's `onCreate` and `onNewIntent` so a tapped
 * notification reaches [pendingTap].
 */
object WeldPush {
    private var env: AppEnvironment? = null
    private var launchActivity: Class<out Activity>? = null
    @DrawableRes private var smallIcon: Int = 0
    private val taps = MutableStateFlow<PushPayload?>(null)

    /** A tapped notification the app hasn't handled yet; take it with [takeTap]. */
    val pendingTap: StateFlow<PushPayload?> = taps.asStateFlow()

    /**
     * A data message the app handles itself (WeldChat's call ring); return
     * true when it did, and no notification is shown for it.
     */
    var dataHandler: ((Context, PushPayload) -> Boolean)? = null

    /** Whether a push that arrives while the app is open shows a notification (default: yes). */
    var shouldShow: (PushPayload) -> Boolean = { true }

    /**
     * @param channels the app's channels; a `default` one is always made.
     * @param smallIcon the white status-bar icon.
     */
    fun init(
        context: Context,
        env: AppEnvironment,
        options: FcmOptions,
        launchActivity: Class<out Activity>,
        @DrawableRes smallIcon: Int,
        channels: List<PushChannel> = emptyList(),
    ) {
        this.env = env
        this.launchActivity = launchActivity
        this.smallIcon = smallIcon
        createChannels(context, channels)
        if (!options.isComplete) return
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setProjectId(options.projectId)
                    .setApplicationId(options.applicationId)
                    .setApiKey(options.apiKey)
                    .setGcmSenderId(options.senderId)
                    .build(),
            )
        }
        env.pushProvider = FcmTokenProvider
    }

    /** Take a tap out of an activity's intent: the extras of a notification this app or FCM showed. */
    fun handleIntent(intent: Intent?) {
        val extras = intent?.extras ?: return
        if (!extras.containsKey(EXTRA_FROM_PUSH) && !extras.containsKey("notificationType")) return
        val values = extras.keySet()
            .filter { !it.startsWith("google.") && !it.startsWith("gcm.") && it != EXTRA_FROM_PUSH && it != "from" && it != "collapse_key" }
            .mapNotNull { key -> extras.getString(key)?.let { key to it } }
            .toMap()
        val payload = PushPayload(values)
        if (env?.acceptsPush(payload) != false) taps.value = payload
        intent.removeExtra(EXTRA_FROM_PUSH)
        intent.removeExtra("notificationType")
    }

    /** The waiting tap, once. */
    fun takeTap(): PushPayload? = taps.value.also { taps.value = null }

    internal fun newToken(token: String) {
        env?.pushTokenChanged(token)
    }

    internal fun received(context: Context, message: RemoteMessage) {
        val payload = PushPayload(message.data)
        if (env?.acceptsPush(payload) == false) return
        if (dataHandler?.invoke(context, payload) == true) return
        val title = message.notification?.title ?: payload["title"] ?: return
        if (!shouldShow(payload)) return
        show(context, title, message.notification?.body ?: payload["body"], message.notification?.channelId ?: payload["channelId"], payload)
    }

    private fun show(context: Context, title: String, body: String?, channel: String?, payload: PushPayload) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val activity = launchActivity ?: return
        val intent = Intent(context, activity).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_FROM_PUSH, "1")
            payload.values.forEach { (key, value) -> putExtra(key, value) }
        }
        val id = (payload.entityId ?: title).hashCode()
        val tap = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val manager = context.getSystemService(NotificationManager::class.java)
        val channelId = channel?.takeIf { Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager.getNotificationChannel(it) != null } ?: DEFAULT_CHANNEL
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    private fun createChannels(context: Context, channels: List<PushChannel>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val all = listOf(PushChannel(DEFAULT_CHANNEL, context.getString(CoreR.string.core_settings_notifications))) + channels
        all.forEach { manager.createNotificationChannel(NotificationChannel(it.id, it.name, it.importance)) }
    }

    private const val EXTRA_FROM_PUSH = "org.weldsuite.push.tap"
    const val DEFAULT_CHANNEL = "default"
}

/** The FCM registration token. */
private object FcmTokenProvider : PushProvider {
    override suspend fun token(): String? = suspendCancellableCoroutine { continuation ->
        runCatching {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (continuation.isActive) continuation.resume(if (task.isSuccessful) task.result else null)
            }
        }.onFailure { if (continuation.isActive) continuation.resume(null) }
    }
}

/** FCM's service: a new token, and messages while the app runs (or data-only ones at any time). */
class WeldMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        WeldPush.newToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        WeldPush.received(applicationContext, message)
    }
}

/** Asks for the notification permission once (Android 13 and later), when shown. */
@Composable
fun NotificationPermissionRequest() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        val prefs = context.getSharedPreferences("weldsuite.push", Context.MODE_PRIVATE)
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted && !prefs.getBoolean("asked", false)) {
            prefs.edit().putBoolean("asked", true).apply()
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
