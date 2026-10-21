package expo.modules.weldchatcalls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * The ringing incoming-call notification: the system call layout (caller name,
 * Answer / Decline), shown full screen over the lock screen when the device is
 * locked, ringing with the phone's ringtone until answered, declined, cancelled
 * by the server or timed out.
 */
internal object CallRinger {
  // A channel's sound and importance are fixed once created; bump the id to change them.
  private const val CHANNEL_ID = "weldchat_call_ring_v1"
  private const val TAG = "weldchat_call"
  private const val LOG_TAG = "WeldChatCalls"
  /** Fallback when the push carries no expiry; the server cancels well before. */
  private const val DEFAULT_RING_MS = 60_000L

  const val EXTRA_ACTION = "weldchat_call_action"
  const val EXTRA_PAYLOAD = "weldchat_call_payload"
  const val ACTION_ACCEPT = "accept"
  const val ACTION_OPEN = "open"
  const val ACTION_DECLINE = "decline"

  private fun notificationId(callId: String) = callId.hashCode()

  /** Show the ring. Returns false when it was not shown (expired, or notifications off). */
  fun show(context: Context, payload: Map<String, String>, labels: Map<String, String>): Boolean {
    val callId = payload["callId"].orEmpty()
    if (callId.isEmpty()) return false
    val expiresAt = payload["expiresAt"]?.toLongOrNull() ?: (System.currentTimeMillis() + DEFAULT_RING_MS)
    val remaining = expiresAt - System.currentTimeMillis()
    if (remaining <= 0) return false

    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    ensureChannel(context, labels)

    val isVideo = payload["callType"] == "video"
    val callerName = payload["callerName"].orEmpty().ifEmpty { labels["unknownCaller"] ?: "WeldChat" }
    val subtitle = (if (isVideo) labels["incomingVideo"] else labels["incomingVoice"]) ?: ""

    val open = activityIntent(context, payload, ACTION_OPEN)
    val answer = activityIntent(context, payload, ACTION_ACCEPT)
    val decline = declineIntent(context, payload)
    val caller = Person.Builder().setName(callerName).setImportant(true).build()

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(callerName)
      .setContentText(subtitle)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(false)
      .setContentIntent(open)
      // Over the lock screen (or a heads-up when the device is in use).
      .setFullScreenIntent(open, true)
      .setTimeoutAfter(remaining)
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(isVideo))
      .build()
    // Keep ringing (sound + vibration loop) until the notification is gone.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT

    return try {
      manager.notify(TAG, notificationId(callId), notification)
      true
    } catch (e: SecurityException) {
      Log.w(LOG_TAG, "Cannot post the call notification", e)
      false
    }
  }

  fun cancel(context: Context, callId: String) {
    NotificationManagerCompat.from(context).cancel(TAG, notificationId(callId))
  }

  /** Android 14+ only grants full-screen intents to calling apps; earlier always true. */
  fun canUseFullScreenIntent(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    return manager.canUseFullScreenIntent()
  }

  private fun ensureChannel(context: Context, labels: Map<String, String>) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      labels["channelName"] ?: "Incoming calls",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = labels["channelDescription"]
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
    manager.createNotificationChannel(channel)
  }

  private fun smallIcon(context: Context): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  /** Opens the app (MainActivity) with the action; the activity listener hands it to JS. */
  private fun activityIntent(context: Context, payload: Map<String, String>, action: String): PendingIntent {
    val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_ACTION, action)
      .putExtra(EXTRA_PAYLOAD, CallStore.payloadToJson(payload))
    return PendingIntent.getActivity(
      context,
      requestCode(payload, action),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun declineIntent(context: Context, payload: Map<String, String>): PendingIntent {
    val intent = Intent(context, CallActionReceiver::class.java)
      .setAction(ACTION_DECLINE)
      .putExtra(EXTRA_PAYLOAD, CallStore.payloadToJson(payload))
    return PendingIntent.getBroadcast(
      context,
      requestCode(payload, ACTION_DECLINE),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun requestCode(payload: Map<String, String>, action: String) =
    "${payload["callId"]}:$action".hashCode()
}
