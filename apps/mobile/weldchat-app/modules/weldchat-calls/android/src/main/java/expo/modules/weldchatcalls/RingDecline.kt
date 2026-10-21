package expo.modules.weldchatcalls

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** POST /public/chat-calls/decline with the ring token. Blocking; call off the main thread. */
internal object RingDecline {
  fun post(url: String, token: String) {
    var connection: HttpURLConnection? = null
    try {
      connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 8_000
        readTimeout = 8_000
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
      connection.outputStream.use { it.write(JSONObject(mapOf("token" to token)).toString().toByteArray()) }
      val status = connection.responseCode
      if (status !in 200..299) Log.w("WeldChatCalls", "Ring decline failed: HTTP $status")
    } catch (e: Exception) {
      Log.w("WeldChatCalls", "Ring decline failed", e)
    } finally {
      connection?.disconnect()
    }
  }
}
