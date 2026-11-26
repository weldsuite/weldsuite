package org.weldsuite.core.api

import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import org.weldsuite.api.core.models.ErrorResponse
import org.weldsuite.core.WeldJson
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException

/** What an API call needs from the session. */
interface ApiAuth {
    suspend fun token(): String?
    suspend fun refreshedToken(): String?
    val workspaceId: String?
}

/**
 * The generated API interfaces, pointed at one server: every request carries
 * the bearer token, `X-Weld-App` and, except the workspace list itself,
 * `X-Weld-Workspace`. A 401 refreshes the token once and tries again.
 */
class ApiClient(origin: String, appCode: String, auth: ApiAuth, http: OkHttpClient) {
    private val client = http.newBuilder()
        .addInterceptor(WeldHeaders(appCode, auth))
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl("${origin.trimEnd('/')}/")
        .client(client)
        .addConverterFactory(WeldJson.asConverterFactory("application/json".toMediaType()))
        .build()

    fun <T> create(service: Class<T>): T = retrofit.create(service)

    inline fun <reified T> create(): T = create(T::class.java)
}

private class WeldHeaders(private val appCode: String, private val auth: ApiAuth) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        // OkHttp runs interceptors on its own threads, so waiting here blocks no UI.
        val token = runBlocking { auth.token() }
        val request = original.newBuilder()
            .header("Accept", "application/json")
            .header("X-Weld-App", appCode)
            .apply {
                token?.let { header("Authorization", "Bearer $it") }
                val workspace = auth.workspaceId
                if (workspace != null && original.url.encodedPath != WORKSPACES_PATH) header("X-Weld-Workspace", workspace)
            }
            .build()
        val response = chain.proceed(request)
        if (response.code != 401 || token == null) return response
        val fresh = runBlocking { auth.refreshedToken() } ?: return response
        response.close()
        return chain.proceed(request.newBuilder().header("Authorization", "Bearer $fresh").build())
    }

    private companion object {
        const val WORKSPACES_PATH = "/api/workspaces"
    }
}

/**
 * A failed API call. [status] is null when the server wasn't reached;
 * [code] is the server's error code (`CRYPTO_ERROR`, …) when it sent one.
 */
class ApiException(val status: Int?, val code: String?, message: String?, cause: Throwable? = null) :
    Exception(message ?: "Request failed (${status ?: "network"})", cause) {
    val isNetwork: Boolean get() = status == null
}

/** The body of a successful call, or an [ApiException]. */
suspend fun <T> apiCall(block: suspend () -> retrofit2.Response<T>): T {
    val response = try {
        block()
    } catch (exception: IOException) {
        throw ApiException(status = null, code = null, message = exception.message, cause = exception)
    }
    if (response.isSuccessful) {
        return response.body() ?: throw ApiException(response.code(), null, "Empty response")
    }
    val error = response.errorBody()?.string()?.let {
        runCatching { WeldJson.decodeFromString(ErrorResponse.serializer(), it).error }.getOrNull()
    }
    throw ApiException(response.code(), error?.code, error?.message)
}
