package expo.modules.weldchatcalls

import android.content.Context
import org.json.JSONObject

/** Something the user did on the native call UI, for JS to act on. */
internal data class CallAction(val action: String, val payload: Map<String, String>) {
  fun toMap(): Map<String, Any?> = mapOf("action" to action, "payload" to payload)
}

/**
 * Process-wide call state shared by the module, the notification receiver and
 * the activity listener, which can each run without the others (a Decline tap
 * on a killed app starts only the receiver).
 *
 * Actions wait in [pending] until JS listens: an Answer tap cold-starts the
 * app, and JS is up seconds after the activity received the intent.
 */
internal object CallStore {
  private const val PREFS = "weldchat_calls"
  private const val KEY_DECLINE_URL = "decline_url"

  private val pending = mutableListOf<CallAction>()
  private var listener: ((CallAction) -> Unit)? = null

  /** True while MainActivity is resumed (the app is on screen). */
  @Volatile var foreground = false

  @Synchronized
  fun setListener(next: ((CallAction) -> Unit)?) {
    listener = next
  }

  @Synchronized
  fun dispatch(action: CallAction) {
    val current = listener
    if (current != null) current(action) else pending.add(action)
  }

  @Synchronized
  fun takePending(): List<CallAction> {
    val out = pending.toList()
    pending.clear()
    return out
  }

  /** Persisted: a Decline tap on a killed app needs it before JS runs. */
  fun setDeclineUrl(context: Context, url: String?) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_DECLINE_URL, url).apply()
  }

  fun declineUrl(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_DECLINE_URL, null)

  fun payloadToJson(payload: Map<String, String>): String = JSONObject(payload).toString()

  fun payloadFromJson(json: String?): Map<String, String> {
    if (json.isNullOrEmpty()) return emptyMap()
    return try {
      val obj = JSONObject(json)
      obj.keys().asSequence().associateWith { obj.optString(it) }
    } catch (_: Exception) {
      emptyMap()
    }
  }
}
