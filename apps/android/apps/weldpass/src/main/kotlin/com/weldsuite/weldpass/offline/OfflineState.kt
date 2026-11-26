package com.weldsuite.weldpass.offline

import kotlinx.serialization.builtins.ListSerializer
import org.weldsuite.api.weldpass.models.DeviceEvent
import org.weldsuite.core.WeldJson
import org.weldsuite.core.storage.KeyValueStore

/** Where the offline copy stands. */
enum class OfflineStatus {
    /** Signed out, or the server doesn't offer offline copies. */
    OFF,

    /** This phone has no screen lock to keep the key behind. */
    UNAVAILABLE,

    /** Waiting for the person to unlock. */
    LOCKED,

    /** The copy is open (it may still be empty until the first sync). */
    READY,

    /** The workspace switched offline copies off. */
    DISABLED,

    /** This phone's copy was revoked; it stays off until turned on again. */
    REVOKED,
}

data class OfflineState(
    val status: OfflineStatus = OfflineStatus.OFF,
    /** Open; holds at least one sync's worth of data once `syncedAt` is set. */
    val copy: OfflineCopy? = null,
    val syncing: Boolean = false,
    /** The last sync couldn't reach the server: the lists are the copy from `copy.syncedAt`. */
    val offline: Boolean = false,
    /** This phone's device id on the server, once registered. */
    val deviceId: String? = null,
) {
    /** The copy to read from: open and synced at least once. */
    val readable: OfflineCopy? get() = copy?.takeIf { status == OfflineStatus.READY && it.syncedAt.isNotEmpty() }
}

/**
 * What the phone did with its copy (a reveal, a copy, an autofill), queued
 * until the next sync uploads it into the vaults' trails. Ids and actions
 * only, never a secret. The Expo app's `lib/offline/events.ts`.
 */
class EventQueue(private val store: KeyValueStore) {
    private val serializer = ListSerializer(DeviceEvent.serializer())

    private fun key(workspaceId: String) = "weldpass:offline-events:$workspaceId"

    fun read(workspaceId: String): List<DeviceEvent> =
        store.get(key(workspaceId))?.let { runCatching { WeldJson.decodeFromString(serializer, it) }.getOrNull() }.orEmpty()

    fun add(workspaceId: String, event: DeviceEvent) {
        val events = (read(workspaceId) + event).takeLast(MAX_QUEUED)
        store.set(key(workspaceId), WeldJson.encodeToString(serializer, events))
    }

    /**
     * Upload the queue in batches, oldest first. Each batch the server took
     * leaves the front of the queue, so a failure part-way keeps only what
     * wasn't sent, and an event recorded meanwhile stays queued.
     */
    suspend fun flush(workspaceId: String, upload: suspend (List<DeviceEvent>) -> Any?) {
        while (true) {
            val batch = read(workspaceId).take(PER_UPLOAD)
            if (batch.isEmpty()) return
            upload(batch)
            val rest = read(workspaceId).drop(batch.size)
            if (rest.isEmpty()) store.remove(key(workspaceId)) else store.set(key(workspaceId), WeldJson.encodeToString(serializer, rest))
        }
    }

    fun clear(workspaceId: String) {
        store.remove(key(workspaceId))
    }

    companion object {
        const val MAX_QUEUED = 2000
        const val PER_UPLOAD = 500
    }
}
