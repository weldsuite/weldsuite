package expo.modules.weldchatcalls

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android side of the WeldChat incoming-call ring: shows / dismisses the
 * full-screen call notification and hands the user's Answer / Decline / tap
 * to JS (`onCallAction`). The iOS side of the same API runs CallKit.
 */
class WeldChatCallsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("WeldChatCalls")

    Events("onCallAction", "onVoipToken")

    OnStartObserving {
      CallStore.setListener { action -> sendEvent("onCallAction", action.toMap()) }
    }

    OnStopObserving {
      CallStore.setListener(null)
    }

    /** Where the notification's Decline posts the ring token. */
    Function("configure") { declineUrl: String? ->
      CallStore.setDeclineUrl(context, declineUrl)
    }

    Function("showIncomingCall") { payload: Map<String, Any?>, labels: Map<String, Any?> ->
      CallRinger.show(context, payload.stringValues(), labels.stringValues())
    }

    /** Take the call's ring / notification down (answered, declined or over). */
    Function("endCall") { callId: String ->
      CallRinger.cancel(context, callId)
    }

    /** Actions taken before JS listened (e.g. Answer on a killed app). */
    Function("takePendingActions") {
      CallStore.takePending().map { it.toMap() }
    }

    Function("isAppInForeground") {
      CallStore.foreground
    }

    Function("canUseFullScreenIntent") {
      CallRinger.canUseFullScreenIntent(context)
    }

    Function("openFullScreenIntentSettings") {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** The call is over: stop showing the app over the lock screen. */
    AsyncFunction("releaseLockScreen") {
      CallActivityListener.activity?.let { CallActivityListener.setShowOverLockScreen(it, false) }
    }.runOnQueue(Queues.MAIN)

    // iOS-only (PushKit / CallKit); kept so JS can call one API on both platforms.
    Function("getVoipToken") { null as String? }
    Function("reportIncomingCall") { _: Map<String, Any?> -> }
  }
}

private fun Map<String, Any?>.stringValues(): Map<String, String> =
  entries.mapNotNull { (key, value) -> value?.let { key to it.toString() } }.toMap()
