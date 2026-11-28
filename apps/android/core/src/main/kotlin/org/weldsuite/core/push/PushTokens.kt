package org.weldsuite.core.push

import android.os.Build
import okhttp3.OkHttpClient
import org.weldsuite.api.core.apis.DefaultApi as CoreApi
import org.weldsuite.api.core.models.PushTokenRegistration
import org.weldsuite.core.AppIdentity
import org.weldsuite.core.api.ApiAuth
import org.weldsuite.core.api.ApiClient
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.storage.KeyValueStore
import java.util.UUID

/**
 * What a push carries in its data, every value a string: `notificationType`,
 * `actionUrl`, `entityType`, `entityId`, `server` (the install it comes from)
 * and whatever the notification adds (`chatChannelId`, …).
 */
data class PushPayload(val values: Map<String, String>) {
    val notificationType: String? get() = this["notificationType"]
    val actionUrl: String? get() = this["actionUrl"]
    val entityType: String? get() = this["entityType"]
    val entityId: String? get() = this["entityId"]
    val server: String? get() = this["server"]

    /** A value, null when absent or empty. */
    operator fun get(key: String): String? = values[key]?.takeIf { it.isNotEmpty() }
}

/** Where this device's push token comes from: FCM, in the `:push` module. */
interface PushProvider {
    /** The current token, asking for one if needed; null when push isn't set up. */
    suspend fun token(): String?
}

/**
 * Registers this device's push tokens with the server, in each workspace the
 * person opens (the tokens live in the workspace's database), and removes
 * them from all of those at sign-out.
 */
class PushTokens(
    private val origin: String,
    private val app: AppIdentity,
    private val auth: ApiAuth,
    private val http: OkHttpClient,
    private val store: KeyValueStore,
    storageId: String,
) {
    private val workspacesKey = "weldsuite:push-workspaces:$storageId:${app.code}"
    private var registered: Pair<String, String>? = null

    /** This install's id for push registrations; a call token uses `<id>:call`. */
    val deviceId: String
        get() = store.get(DEVICE_ID_KEY) ?: UUID.randomUUID().toString().also { store.set(DEVICE_ID_KEY, it) }

    /** Register the FCM token in [workspace], unless it is already there. */
    suspend fun registerFcm(token: String, workspace: String) {
        if (registered == workspace to token) return
        if (register(token, PushTokenRegistration.TokenType.FCM, deviceId, workspace)) registered = workspace to token
    }

    /**
     * Register a token of this device in [workspace]: the FCM token, or
     * WeldChat's call token (`FCM_CALL`, device id `<deviceId>:call`).
     */
    suspend fun register(token: String, type: PushTokenRegistration.TokenType, deviceId: String, workspace: String): Boolean {
        val body = PushTokenRegistration(
            token = token,
            platform = PushTokenRegistration.Platform.ANDROID,
            deviceId = deviceId,
            tokenType = type,
            appCode = app.code,
            deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
            osVersion = Build.VERSION.RELEASE,
            appVersion = app.versionName,
        )
        return runCatching { apiCall { client(workspace).registerPushToken(body) } }
            .onSuccess { known = known + workspace }
            .isSuccess
    }

    /** Stop pushes to this device in every workspace it registered in. Runs before the session's tokens are revoked. */
    suspend fun unregisterEverywhere() {
        val id = deviceId
        for (workspace in known) {
            runCatching { apiCall { client(workspace).unregisterPushToken(id) } }
        }
        known = emptySet()
        registered = null
    }

    private var known: Set<String>
        get() = store.get(workspacesKey)?.split('\n')?.filter { it.isNotEmpty() }?.toSet().orEmpty()
        set(value) = store.set(workspacesKey, value.joinToString("\n"))

    private fun client(workspace: String): CoreApi {
        val fixed = object : ApiAuth {
            override suspend fun token(): String? = auth.token()
            override suspend fun refreshedToken(): String? = auth.refreshedToken()
            override val workspaceId: String = workspace
        }
        return ApiClient(origin, app.code, fixed, http).create<CoreApi>()
    }

    private companion object {
        const val DEVICE_ID_KEY = "weldsuite.push.deviceId"
    }
}
