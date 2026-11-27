package com.weldsuite.weldchat.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException

/**
 * The call notifications' buttons: Decline on the ring (also with the app
 * closed: the ring's signed token declines it without a session, through
 * `declineRing`, `POST /public/chat-calls/decline`), and hang up on the
 * joined call's notification.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_HANG_UP -> CallRinging.manager?.leaveCall()
            ACTION_DECLINE -> decline(context, intent)
        }
    }

    private fun decline(context: Context, intent: Intent) {
        val extras = intent.getBundleExtra(CallRinging.EXTRA_PAYLOAD) ?: return
        val values = extras.keySet().mapNotNull { key -> extras.getString(key)?.let { key to it } }.toMap()
        val call = CallPushes.fromExtras(values) ?: return
        CallRinging.cancelRing(context, call.callId)

        val env = CallRinging.env
        val token = call.declineToken
        val handled = env != null && !token.isNullOrEmpty()
        CallRinging.manager?.onDeclinedFromNotification(call, declinedOnServer = handled)
        if (env == null || token.isNullOrEmpty()) return

        // Keeps the process alive for the request (up to about ten seconds).
        val pending = goAsync()
        val body = buildJsonObject { put("token", token) }.toString().toRequestBody(JSON)
        val request = Request.Builder()
            .url("${env.serverOrigin}/public/chat-calls/decline")
            .post(body)
            .build()
        env.http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                pending.finish()
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
                pending.finish()
            }
        })
    }

    companion object {
        const val ACTION_DECLINE = "com.weldsuite.weldchat.call.DECLINE"
        const val ACTION_HANG_UP = "com.weldsuite.weldchat.call.HANG_UP"
        private val JSON = "application/json".toMediaType()
    }
}
