package com.weldsuite.weldchat.calls

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import com.weldsuite.weldchat.R
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.push.PushPayload
import org.weldsuite.push.WeldPush

/**
 * The native ring (ADR CHAT-005), the Android half of the Expo app's
 * `weldchat-calls` module: the server sends this device's call token
 * (`fcm_call`) a data-only, high-priority FCM message for every ring
 * (`chat_call_ring`) and when it stops (`chat_call_cancel`). With the app on
 * screen the ring shows in the app; otherwise as the system's call
 * notification (`CallStyle`), over the lock screen, ringing until answered,
 * declined, cancelled by the server or timed out.
 */
object CallRinging {
    /** The ring's channel (the server's `incoming_call`): high importance, the ringtone. */
    const val CHANNEL_INCOMING = "incoming_call"

    /** The joined call's ongoing notification: silent. */
    const val CHANNEL_ONGOING = "call_ongoing"

    const val EXTRA_ACTION = "com.weldsuite.weldchat.call.action"
    const val EXTRA_PAYLOAD = "com.weldsuite.weldchat.call.payload"
    const val ACTION_ACCEPT = "accept"
    const val ACTION_OPEN = "open"

    /** The ongoing call's notification: back to the call. */
    const val ACTION_RETURN = "return"

    private const val TAG = "weldchat_call"

    /** The app's call manager, once made (it registers itself). */
    @Volatile
    internal var manager: CallManager? = null

    @Volatile
    internal var env: AppEnvironment? = null

    private val main = Handler(Looper.getMainLooper())

    /** Make the call channels and take the call pushes. Call once, in `Application.onCreate`, after `WeldPush.init`. */
    fun install(application: Application, env: AppEnvironment) {
        this.env = env
        createChannels(application)
        val previous = WeldPush.dataHandler
        WeldPush.dataHandler = { context, payload -> handle(context, payload) || previous?.invoke(context, payload) == true }
    }

    /** A data message: true when it was a call push (handled or dropped), so no notification is shown for it. */
    internal fun handle(context: Context, payload: PushPayload): Boolean {
        val push = CallPushes.parse(payload.values) ?: return false
        // A ring without `server` comes from WeldSuite cloud, for a call this app can't join.
        if (payload.server.isNullOrBlank()) return true
        if (env?.isAvailable("chat-calls") == false) return true
        val app = context.applicationContext
        main.post {
            when (push) {
                is CallPush.Ring -> ring(app, push.call)
                is CallPush.Cancel -> {
                    cancelRing(app, push.callId)
                    manager?.dismissRing(push.callId)
                }
            }
        }
        return true
    }

    private fun ring(context: Context, call: IncomingCall) {
        val manager = manager
        if (manager != null && (manager.wasEnded(call.callId) || manager.isInCall(call.callId))) return
        if (manager != null && manager.isForeground()) manager.present(call) else showRing(context, call)
    }

    /** The ringing call notification. False when it isn't shown (expired, or notifications off). */
    internal fun showRing(context: Context, call: IncomingCall): Boolean {
        val now = System.currentTimeMillis()
        val remaining = (call.expiresAt ?: (now + CallRules.DEFAULT_RING_MS)) - now
        if (remaining <= 0) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        val notifications = NotificationManagerCompat.from(context)
        if (!notifications.areNotificationsEnabled()) return false
        val video = call.callType == CallType.VIDEO
        val name = call.callerName ?: context.getString(R.string.weldchat_call_unknown_caller)
        val caller = Person.Builder().setName(name).setImportant(true).build()
        val open = activityIntent(context, call, ACTION_OPEN)
        val answer = activityIntent(context, call, ACTION_ACCEPT)
        val decline = receiverIntent(context, CallActionReceiver.ACTION_DECLINE, call)
        val notification = NotificationCompat.Builder(context, CHANNEL_INCOMING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(name)
            .setContentText(context.getString(if (video) R.string.weldchat_call_incoming_video else R.string.weldchat_call_incoming_voice))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            // Over the lock screen, or a heads-up while the phone is in use.
            .setFullScreenIntent(open, true)
            .setTimeoutAfter(remaining)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
            .build()
        // Ringing (sound and vibration) until the notification goes.
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        return try {
            notifications.notify(TAG, notificationId(call.callId), notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    /** Stop the ring's notification for a call. */
    fun cancelRing(context: Context, callId: String) {
        NotificationManagerCompat.from(context).cancel(TAG, notificationId(callId))
    }

    /** The joined call's notification, for its foreground service: hang up, or back to the call. */
    internal fun ongoingNotification(context: Context, title: String?, video: Boolean): Notification {
        val name = title ?: context.getString(if (video) R.string.weldchat_in_call_video_call else R.string.weldchat_in_call_voice_call)
        val person = Person.Builder().setName(name).setImportant(true).build()
        val hangUp = receiverIntent(context, CallActionReceiver.ACTION_HANG_UP, null)
        val back = launchIntent(context).putExtra(EXTRA_ACTION, ACTION_RETURN)
        val open = PendingIntent.getActivity(context, ACTION_RETURN.hashCode(), back, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(name)
            .setContentText(context.getString(R.string.weldchat_call_ongoing_notification))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp).setIsVideo(video))
            .build()
    }

    private fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val incoming = NotificationChannel(
            CHANNEL_INCOMING,
            context.getString(R.string.weldchat_call_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.weldchat_call_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1000, 1000)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
        }
        val ongoing = NotificationChannel(
            CHANNEL_ONGOING,
            context.getString(R.string.weldchat_call_ongoing_notification),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        manager.createNotificationChannels(listOf(incoming, ongoing))
    }

    /** The app's main activity, brought to the front. */
    private fun launchIntent(context: Context): Intent =
        (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    private fun activityIntent(context: Context, call: IncomingCall, action: String): PendingIntent {
        val intent = launchIntent(context)
            .putExtra(EXTRA_ACTION, action)
            .putExtra(EXTRA_PAYLOAD, payloadBundle(call))
        return PendingIntent.getActivity(
            context,
            "${call.callId}:$action".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun receiverIntent(context: Context, action: String, call: IncomingCall?): PendingIntent {
        val intent = Intent(context, CallActionReceiver::class.java).setAction(action)
        if (call != null) intent.putExtra(EXTRA_PAYLOAD, payloadBundle(call))
        return PendingIntent.getBroadcast(
            context,
            "${call?.callId}:$action".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun payloadBundle(call: IncomingCall) = bundleOf(*CallPushes.toExtras(call).toList().toTypedArray())

    private fun notificationId(callId: String) = callId.hashCode()
}
