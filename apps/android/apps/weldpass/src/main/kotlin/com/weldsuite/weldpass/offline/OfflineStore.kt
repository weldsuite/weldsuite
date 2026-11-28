package com.weldsuite.weldpass.offline

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.weldsuite.api.weldpass.apis.DefaultApi
import org.weldsuite.api.weldpass.models.Device
import org.weldsuite.api.weldpass.models.DeviceEvent
import org.weldsuite.api.weldpass.models.DeviceEvents
import org.weldsuite.api.weldpass.models.RegisterDevice
import org.weldsuite.api.weldpass.models.SyncRequest
import org.weldsuite.api.weldpass.models.SyncResult
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.api.apiCallNoContent
import org.weldsuite.core.storage.PreferencesStore
import java.time.Instant

/**
 * The offline copy in the running app (ADR PASS-010).
 *
 * - **Unlocking** the app opens the copy's key, which only works shortly
 *   after the person unlocks, so the lock's one prompt opens both. The key
 *   stays in memory while the app is unlocked and is dropped when it locks.
 * - **Syncing** happens after every unlock, when the app comes back to the
 *   foreground (at most every 30 s) and after every write.
 * - **Reading**: lists and item fields come from the copy while it's open, so
 *   the app works without a connection. Edits go to the server.
 * - **Wiping**: on sign-out (this phone is revoked on the server first), when
 *   the server says the phone was revoked or offline copies are off, and per
 *   vault when the person loses access.
 */
class OfflineStore(context: Context, private val env: AppEnvironment, private val appVersion: String) {
    private val appContext = context.applicationContext
    private val keys = CopyKeyStore(appContext)
    private val files = CopyFiles(appContext)
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val store = PreferencesStore(appContext, PREFS)
    private val events = EventQueue(store)
    private val mutex = Mutex()
    private val api: DefaultApi get() = env.api.create()

    private val state = MutableStateFlow(OfflineState())
    val snapshot: StateFlow<OfflineState> = state.asStateFlow()

    /** The copy's cipher, in memory while the app is unlocked. */
    private var cipher: AesGcmCipher? = null
    private var session: Session? = null
    private var lastSyncAt = 0L

    private data class Session(val server: String, val userId: String, val workspaceId: String) {
        val key: String get() = "$server|$userId|$workspaceId"
    }

    init {
        env.scope.launch {
            combine(env.state, env.lock.locked) { session, locked -> session to locked }
                .collect { (session, locked) -> follow(session, locked) }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                if (System.currentTimeMillis() - lastSyncAt >= FOREGROUND_SYNC_MS) env.scope.launch { sync() }
            }
        })
    }

    /** Follow the session and the lock: open, close or switch the copy. */
    private suspend fun follow(sessionState: SessionState, locked: Boolean) {
        val ready = sessionState as? SessionState.Ready
        if (ready == null) {
            close(OfflineStatus.OFF)
            session = null
            return
        }
        val next = Session(env.serverOrigin, ready.person.id, ready.workspace.id)
        val status = when {
            "weldpass-offline" in env.unavailableFeatures -> OfflineStatus.OFF
            !env.lock.hasScreenLock() -> OfflineStatus.UNAVAILABLE
            locked -> OfflineStatus.LOCKED
            else -> null
        }
        if (status != null) {
            session = next
            close(status)
            return
        }
        // Unlocked: open when the copy isn't open for this session yet.
        if (next == session && state.value.status == OfflineStatus.READY && cipher != null) return
        if (next == session && state.value.status in setOf(OfflineStatus.REVOKED, OfflineStatus.DISABLED)) return
        session = next
        open(next)
    }

    private fun close(status: OfflineStatus) {
        cipher = null
        state.value = OfflineState(status = status)
    }

    private suspend fun open(session: Session) {
        val key = try {
            keys.open()
        } catch (_: CopyLockedException) {
            close(OfflineStatus.LOCKED)
            return
        }
        cipher = AesGcmCipher(key)
        if (prefs.getString(revokedKey(session), null) != null) {
            state.value = OfflineState(status = OfflineStatus.REVOKED)
            return
        }
        val deviceId = prefs.getString(deviceKey(session), null)
        val copy = deviceId?.let { load(CopyOwner(session.server, session.userId, session.workspaceId, it)) }
        state.value = OfflineState(status = OfflineStatus.READY, copy = copy, deviceId = deviceId)
        sync()
    }

    /** One sync, when the copy is open. Offline, the copy stays as it was and `offline` is set. */
    suspend fun sync() = mutex.withLock {
        val session = session ?: return@withLock
        val cipher = cipher ?: return@withLock
        if (state.value.status != OfflineStatus.READY) return@withLock
        state.update { it.copy(syncing = true) }
        try {
            runSync(session, cipher)
        } catch (error: ApiException) {
            state.update { it.copy(offline = error.isNetwork) }
        } finally {
            lastSyncAt = System.currentTimeMillis()
            state.update { it.copy(syncing = false) }
        }
    }

    private suspend fun runSync(session: Session, cipher: AesGcmCipher) {
        var deviceId = ensureDevice(session) ?: return close(OfflineStatus.OFF)
        var owner = CopyOwner(session.server, session.userId, session.workspaceId, deviceId)
        var copy = state.value.copy?.takeIf { CopyRules.belongsTo(it, owner) } ?: load(owner)
        val result = try {
            apiCall { api.syncDevice(deviceId, SyncRequest(CopyRules.cursorsOf(copy))) }.data
        } catch (error: ApiException) {
            // The server no longer knows this device: register again and start from scratch, once.
            if (error.status != 404) throw error
            prefs.edit().remove(deviceKey(session)).apply()
            files.delete(session.workspaceId)
            deviceId = ensureDevice(session) ?: return close(OfflineStatus.OFF)
            owner = CopyOwner(session.server, session.userId, session.workspaceId, deviceId)
            copy = CopyRules.empty(owner)
            apiCall { api.syncDevice(deviceId, SyncRequest(emptyMap())) }.data
        }
        when (val outcome = CopyRules.apply(copy, result)) {
            is SyncOutcome.Wiped -> {
                // Switched off by the workspace: keep the registration, so the copy
                // comes back when it's switched on. Revoked: forget it, and don't
                // register again on our own (the person turns it on in Settings).
                val disabled = outcome.reason == SyncResult.Reason.DISABLED
                wipeWorkspace(session, forgetDevice = !disabled)
                if (outcome.reason == SyncResult.Reason.REVOKED) {
                    prefs.edit().putString(revokedKey(session), Instant.now().toString()).apply()
                }
                state.value = OfflineState(status = if (disabled) OfflineStatus.DISABLED else OfflineStatus.REVOKED)
            }
            is SyncOutcome.Updated -> {
                val json = WeldJson.encodeToString(OfflineCopy.serializer(), outcome.copy)
                files.write(session.workspaceId, deviceId, CopyEnvelope.seal(json, owner, cipher))
                state.value = OfflineState(status = OfflineStatus.READY, copy = outcome.copy, deviceId = deviceId)
                // Kept for the next sync when it fails.
                runCatching {
                    events.flush(session.workspaceId) { batch ->
                        apiCall { api.uploadDeviceEvents(deviceId, DeviceEvents(batch)) }
                    }
                }
            }
        }
    }

    /** This phone's device id on the server, registering it the first time. Null: the server keeps no copies. */
    private suspend fun ensureDevice(session: Session): String? {
        prefs.getString(deviceKey(session), null)?.let { return it }
        val device = try {
            apiCall { api.registerDevice(RegisterDevice(name = deviceName(), platform = RegisterDevice.Platform.ANDROID, appVersion = appVersion)) }.data
        } catch (error: ApiException) {
            if (error.status == 404 || error.status == 405) return null
            throw error
        }
        prefs.edit().putString(deviceKey(session), device.id).apply()
        return device.id
    }

    /** The copy on the phone for [owner]. A missing file, or one that doesn't open or isn't theirs, is an empty copy. */
    private fun load(owner: CopyOwner): OfflineCopy {
        val cipher = cipher ?: return CopyRules.empty(owner)
        val bytes = files.read(owner.workspaceId) ?: return CopyRules.empty(owner)
        val copy = runCatching {
            CopyEnvelope.open(bytes, owner, cipher)?.let { WeldJson.decodeFromString(OfflineCopy.serializer(), it) }
        }.getOrNull()
        if (copy != null && CopyRules.belongsTo(copy, owner)) return copy
        files.delete(owner.workspaceId)
        return CopyRules.empty(owner)
    }

    /** A reveal, copy or autofill done from the copy, for the vault's trail. */
    fun recordEvent(vaultId: String, itemId: String, action: DeviceEvent.Action) {
        val session = session ?: return
        events.add(session.workspaceId, DeviceEvent(vaultId, itemId, action, Instant.now().toString()))
    }

    /** Turn the copy on again after this phone was revoked. */
    suspend fun enableAgain() {
        val session = session ?: return
        prefs.edit().remove(revokedKey(session)).apply()
        open(session)
    }

    /** The person's phones with a copy. */
    suspend fun devices(): List<Device> = apiCall { api.listDevices() }.data.filter { it.revokedAt == null }

    /** Remove a phone's copy: it's wiped at that phone's next sync. */
    suspend fun revoke(deviceId: String) {
        apiCallNoContent { api.revokeDevice(deviceId) }
    }

    /** Before signing out: revoke this phone on the server (best effort), then wipe every copy and the key. */
    suspend fun signOut() {
        val deviceId = session?.let { prefs.getString(deviceKey(it), null) }
        if (deviceId != null) runCatching { revoke(deviceId) }
        files.deleteAll()
        prefs.edit().clear().apply()
        keys.delete()
        close(OfflineStatus.OFF)
    }

    private fun wipeWorkspace(session: Session, forgetDevice: Boolean) {
        files.delete(session.workspaceId)
        if (forgetDevice) prefs.edit().remove(deviceKey(session)).apply()
        events.clear(session.workspaceId)
    }

    private fun deviceKey(session: Session) = "weldpass:device:${session.key}"

    private fun revokedKey(session: Session) = "weldpass:offline-revoked:${session.key}"

    /** The name the person gave the phone (Android 7.1+), else its model. */
    private fun deviceName(): String {
        val given = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
            Settings.Global.getString(appContext.contentResolver, Settings.Global.DEVICE_NAME)
        } else {
            null
        }
        return (given ?: Build.MODEL ?: "Android").take(100)
    }

    private companion object {
        const val PREFS = "weldpass.offline.state"
        const val FOREGROUND_SYNC_MS = 30_000L
    }
}
