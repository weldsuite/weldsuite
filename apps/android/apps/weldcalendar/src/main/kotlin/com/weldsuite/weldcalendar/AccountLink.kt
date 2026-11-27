package com.weldsuite.weldcalendar

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Request
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson

/**
 * The account page where a person deletes their account (`auth.accountUrl`
 * in the server's `/config.json`), which the core doesn't hand to the apps
 * yet. Null when the server names none, or can't be reached.
 */
object AccountLink {
    suspend fun accountUrl(env: AppEnvironment): String? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url("${env.serverOrigin}/config.json").header("Accept", "application/json").build()
            env.http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                accountUrlOf(response.body?.string())
            }
        }.getOrNull()
    }

    /** `auth.accountUrl` of a `/config.json` body, when it is an https link. */
    fun accountUrlOf(body: String?): String? {
        val text = body ?: return null
        val root = runCatching { WeldJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        val auth = root["auth"] as? JsonObject ?: return null
        val url = (auth["accountUrl"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        return url.takeIf { it.startsWith("https://") }
    }
}
