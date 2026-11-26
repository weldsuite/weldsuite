package org.weldsuite.core.server

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.weldsuite.api.core.models.RuntimeConfig
import org.weldsuite.core.WeldJson
import org.weldsuite.core.auth.storageIdFor
import org.weldsuite.core.storage.KeyValueStore
import java.util.concurrent.TimeUnit

/** A server's `/config.json`, fresh or from the last good copy on the phone. */
sealed interface ConfigResult {
    data class Loaded(val config: RuntimeConfig, val fromCache: Boolean) : ConfigResult
    data class Problem(val problem: ServerProblem) : ConfigResult
}

/**
 * Reads `<origin>/config.json`. The last good copy is kept, so the app opens
 * offline; an answer that isn't a WeldSuite document (an HTML page, another
 * product) is never cached.
 */
class ServerConfigLoader(http: OkHttpClient, private val cache: KeyValueStore) {
    private val client = http.newBuilder().callTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS).build()

    suspend fun load(origin: String): ConfigResult = withContext(Dispatchers.IO) {
        val key = "weldsuite:config:${storageIdFor(origin)}"
        val fresh = fetch(origin)
        when {
            fresh is Fetched.Ok -> {
                cache.set(key, fresh.raw)
                ConfigResult.Loaded(fresh.config, fromCache = false)
            }
            fresh is Fetched.NotWeldSuite -> ConfigResult.Problem(ServerProblem.NOT_WELDSUITE)
            else -> cache.get(key)?.let(::parse)?.let { ConfigResult.Loaded(it, fromCache = true) }
                ?: ConfigResult.Problem(ServerProblem.UNREACHABLE)
        }
    }

    private fun fetch(origin: String): Fetched {
        val request = Request.Builder()
            .url("${origin.trimEnd('/')}/config.json")
            .header("Accept", "application/json")
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when {
                    response.code == 404 -> Fetched.NotWeldSuite
                    !response.isSuccessful -> Fetched.Unreachable
                    response.header("Content-Type")?.contains("json") != true -> Fetched.NotWeldSuite
                    else -> {
                        val raw = response.body?.string().orEmpty()
                        val config = parse(raw)
                        if (config?.backend == "rust") Fetched.Ok(config, raw) else Fetched.NotWeldSuite
                    }
                }
            }
        } catch (_: Exception) {
            Fetched.Unreachable
        }
    }

    private fun parse(raw: String): RuntimeConfig? =
        runCatching { WeldJson.decodeFromString(RuntimeConfig.serializer(), raw) }.getOrNull()

    private sealed interface Fetched {
        data class Ok(val config: RuntimeConfig, val raw: String) : Fetched
        data object NotWeldSuite : Fetched
        data object Unreachable : Fetched
    }

    private companion object {
        const val TIMEOUT_SECONDS = 5L
    }
}
