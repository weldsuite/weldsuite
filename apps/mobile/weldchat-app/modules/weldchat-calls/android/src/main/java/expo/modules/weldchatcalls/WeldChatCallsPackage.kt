package expo.modules.weldchatcalls

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.lang.ref.WeakReference

class WeldChatCallsPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> =
    listOf(CallActivityListener)
}

/**
 * Picks up Answer / full-screen taps on the call notification, which open
 * MainActivity with the action in its extras, and shows the activity over the
 * lock screen for the call.
 */
internal object CallActivityListener : ReactActivityLifecycleListener {
  private var activityRef = WeakReference<Activity>(null)

  val activity: Activity? get() = activityRef.get()

  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    activityRef = WeakReference(activity)
    handle(activity, activity.intent)
  }

  override fun onNewIntent(intent: Intent): Boolean {
    activity?.let { handle(it, intent) }
    return false
  }

  override fun onResume(activity: Activity) {
    activityRef = WeakReference(activity)
    CallStore.foreground = true
  }

  override fun onPause(activity: Activity) {
    CallStore.foreground = false
  }

  private fun handle(activity: Activity, intent: Intent?) {
    val action = intent?.getStringExtra(CallRinger.EXTRA_ACTION) ?: return
    val payload = CallStore.payloadFromJson(intent.getStringExtra(CallRinger.EXTRA_PAYLOAD))
    // Consume it so a recreated activity does not answer the same call twice.
    intent.removeExtra(CallRinger.EXTRA_ACTION)
    intent.removeExtra(CallRinger.EXTRA_PAYLOAD)
    val callId = payload["callId"] ?: return

    setShowOverLockScreen(activity, true)
    // Answered: stop ringing now. Opened: JS shows its ring screen and stops it.
    if (action == CallRinger.ACTION_ACCEPT) CallRinger.cancel(activity, callId)
    CallStore.dispatch(CallAction(action, payload))
  }

  fun setShowOverLockScreen(activity: Activity, show: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(show)
      activity.setTurnScreenOn(show)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (show) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }
}
