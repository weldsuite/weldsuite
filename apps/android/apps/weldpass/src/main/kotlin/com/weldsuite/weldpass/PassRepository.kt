package com.weldsuite.weldpass

import com.weldsuite.weldpass.offline.CopyRules
import com.weldsuite.weldpass.offline.OfflineStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import org.weldsuite.api.weldpass.apis.DefaultApi
import org.weldsuite.api.weldpass.models.DeviceEvent
import org.weldsuite.api.weldpass.models.HealthReport
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.ItemFields
import org.weldsuite.api.weldpass.models.ItemInput
import org.weldsuite.api.weldpass.models.TotpCode
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.api.apiCallNoContent

/** A list as the screens show it: what was last loaded, and how loading went. */
data class Loadable<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val error: Throwable? = null,
)

/**
 * Vaults and items for the active workspace: from the offline copy while it's
 * open (ADR PASS-010), from the server otherwise. Lists carry no secrets; a
 * revealed item is handed to the screen that asked and never kept here.
 */
class PassRepository(private val env: AppEnvironment, val offline: OfflineStore) {
    private val api: DefaultApi get() = env.api.create()

    private val serverVaults = MutableStateFlow(Loadable<List<Vault>>())
    private val serverItems = MutableStateFlow(Loadable<List<Item>>())
    private var workspace: String? = null

    val vaults: StateFlow<Loadable<List<Vault>>> = combine(serverVaults, offline.snapshot) { server, copy ->
        copy.readable?.let { Loadable(CopyRules.vaultsOf(it), loading = copy.syncing) } ?: server
    }.stateIn(env.scope, SharingStarted.Eagerly, Loadable())

    val items: StateFlow<Loadable<List<Item>>> = combine(serverItems, offline.snapshot) { server, copy ->
        copy.readable?.let { Loadable(CopyRules.itemsOf(it), loading = copy.syncing) } ?: server
    }.stateIn(env.scope, SharingStarted.Eagerly, Loadable())

    /** Forget another workspace's lists the moment the workspace changes. */
    fun useWorkspace(id: String) {
        if (workspace == id) return
        workspace = id
        serverVaults.value = Loadable()
        serverItems.value = Loadable()
    }

    /** Sync the copy when it's open, else read the lists from the server. */
    suspend fun refresh() {
        if (offline.snapshot.value.readable != null) {
            offline.sync()
            return
        }
        val forWorkspace = workspace
        serverVaults.update { it.copy(loading = true) }
        serverItems.update { it.copy(loading = true) }
        val vaults = runCatching { apiCall { api.listVaults() }.data }
        val items = runCatching { apiCall { api.listItems() }.data }
        if (workspace != forWorkspace) return
        serverVaults.value = vaults.fold(
            onSuccess = { Loadable(it) },
            onFailure = { Loadable(serverVaults.value.data, error = it) },
        )
        serverItems.value = items.fold(
            onSuccess = { Loadable(it) },
            onFailure = { Loadable(serverItems.value.data, error = it) },
        )
    }

    /**
     * The item's secret fields: from the copy when it holds the item (the
     * reveal is queued for the vault's trail), else from the server, which
     * audits it.
     */
    suspend fun reveal(vaultId: String, itemId: String): ItemFields {
        offline.snapshot.value.readable?.let { CopyRules.find(it, vaultId, itemId) }?.let { item ->
            offline.recordEvent(vaultId, itemId, DeviceEvent.Action.REVEALED)
            return item.fields
        }
        return apiCall { api.revealItem(vaultId, itemId) }.data.fields
    }

    /** A secret copied from the copy goes into the vault's trail at the next sync; the server saw a server reveal. */
    fun recordCopy(vaultId: String, itemId: String) {
        if (offline.snapshot.value.readable != null) offline.recordEvent(vaultId, itemId, DeviceEvent.Action.COPIED)
    }

    suspend fun totp(vaultId: String, itemId: String): TotpCode =
        apiCall { api.generateTotp(vaultId, itemId) }.data

    /** Add an item, then sync the copy or reload the lists. */
    suspend fun create(vaultId: String, input: ItemInput): Item {
        val item = apiCall { api.createItem(vaultId, input) }.data
        refresh()
        return item
    }

    /** Replace an item (every field of its type), then sync the copy or reload the lists. */
    suspend fun update(vaultId: String, itemId: String, input: ItemInput): Item {
        val item = apiCall { api.updateItem(vaultId, itemId, input) }.data
        refresh()
        return item
    }

    suspend fun delete(vaultId: String, itemId: String) {
        apiCallNoContent { api.deleteItem(vaultId, itemId) }
        refresh()
    }

    /** Weak, reused and old passwords; worked out on the server without sending a password. */
    suspend fun health(): HealthReport = apiCall { api.passwordHealth() }.data

    fun clear() {
        workspace = null
        serverVaults.value = Loadable()
        serverItems.value = Loadable()
    }
}
