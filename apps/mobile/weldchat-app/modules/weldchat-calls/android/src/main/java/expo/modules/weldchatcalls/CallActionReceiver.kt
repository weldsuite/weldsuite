package expo.modules.weldchatcalls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Decline on the incoming-call notification. Stops the ring at once, then
 * declines on the server with the ring's signed token, which works while the
 * app is not running (no session needed). JS, when it runs, only has to drop
 * its own ring UI.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != CallRinger.ACTION_DECLINE) return
    val payload = CallStore.payloadFromJson(intent.getStringExtra(CallRinger.EXTRA_PAYLOAD))
    val callId = payload["callId"] ?: return
    CallRinger.cancel(context, callId)

    val url = CallStore.declineUrl(context)
    val token = payload["declineToken"]
    val handled = !url.isNullOrEmpty() && !token.isNullOrEmpty()
    CallStore.dispatch(CallAction(CallRinger.ACTION_DECLINE, payload + ("handledNatively" to handled.toString())))
    if (!handled) return

    // goAsync keeps the process alive for the request (up to ~10s).
    val pending = goAsync()
    Thread {
      try {
        RingDecline.post(url!!, token!!)
      } finally {
        pending.finish()
      }
    }.start()
  }
}
