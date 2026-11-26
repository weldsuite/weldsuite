package com.weldsuite.weldpass.autofill

import android.content.Context
import com.weldsuite.weldpass.offline.AesGcmCipher
import com.weldsuite.weldpass.offline.CopyEnvelope
import com.weldsuite.weldpass.offline.CopyFiles
import com.weldsuite.weldpass.offline.CopyOwner
import com.weldsuite.weldpass.offline.EventQueue
import com.weldsuite.weldpass.offline.OfflineCopy
import org.weldsuite.api.weldpass.models.DeviceEvent
import org.weldsuite.api.weldpass.models.SyncedItem
import org.weldsuite.core.WeldJson
import org.weldsuite.core.storage.PreferencesStore
import java.time.Instant

/** A login the autofill can offer: from a copy, with its secret, in this process only. */
data class AutofillLogin(
    val workspaceId: String,
    val vaultId: String,
    val itemId: String,
    val title: String,
    val host: String?,
    val username: String,
    val password: String,
    val apps: List<String>,
)

/**
 * The app's offline copies (ADR PASS-010), as autofill reads them: every copy
 * the index names, opened with the copy's key. Nothing here reaches the
 * network.
 */
object AutofillLogins {
    /** Every login in every copy on the phone, opened with [key]. */
    fun all(context: Context, key: ByteArray): List<AutofillLogin> {
        val files = CopyFiles(context)
        val cipher = AesGcmCipher(key)
        return files.index().flatMap { (workspaceId, deviceId) ->
            val bytes = files.read(workspaceId) ?: return@flatMap emptyList()
            // Only the device and the workspace are bound into the file; the rest is
            // read from the copy itself.
            val owner = CopyOwner(server = "", userId = "", workspaceId = workspaceId, deviceId = deviceId)
            val json = runCatching { CopyEnvelope.open(bytes, owner, cipher) }.getOrNull() ?: return@flatMap emptyList()
            val copy = runCatching { WeldJson.decodeFromString(OfflineCopy.serializer(), json) }.getOrNull()
                ?: return@flatMap emptyList()
            copy.vaults.values.flatMap { vault ->
                vault.items.values.filter { it.type == SyncedItem.Type.LOGIN }.map { item ->
                    AutofillLogin(
                        workspaceId = workspaceId,
                        vaultId = item.vaultId,
                        itemId = item.id,
                        title = item.title,
                        host = item.host?.takeIf { it.isNotEmpty() },
                        username = item.fields.username.orEmpty(),
                        password = item.fields.password.orEmpty(),
                        apps = item.fields.apps.orEmpty(),
                    )
                }
            }
        }.sortedBy { it.title.lowercase() }
    }

    /**
     * The logins for this screen: an app's own by package name (stored in the
     * sealed item, matched only here), a page's by domain, with the
     * platform's `hostsMatch` rule.
     */
    fun matching(logins: List<AutofillLogin>, webDomain: String?, packageName: String): List<AutofillLogin> {
        val domain = webDomain?.removePrefix("www.")
        return logins.filter { login ->
            if (domain != null) login.host?.let { hostsMatch(it, domain) } ?: false else packageName in login.apps
        }
    }

    /** Same host, or one is a subdomain of the other (and the shorter has a dot). */
    fun hostsMatch(itemHost: String, pageHost: String): Boolean {
        val item = itemHost.lowercase().removePrefix("www.")
        val page = pageHost.lowercase().removePrefix("www.")
        if (item == page) return true
        val (short, long) = if (item.length < page.length) item to page else page to item
        return short.contains('.') && long.endsWith(".$short")
    }

    /** A fill, for the vault's trail; the app uploads it at its next sync. */
    fun recordFill(context: Context, login: AutofillLogin) {
        EventQueue(PreferencesStore(context, "weldpass.offline.state")).add(
            login.workspaceId,
            DeviceEvent(login.vaultId, login.itemId, DeviceEvent.Action.AUTOFILLED, Instant.now().toString()),
        )
    }
}
