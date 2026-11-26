package com.weldsuite.weldpass

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.weldsuite.api.weldpass.apis.DefaultApi
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.ItemFields
import org.weldsuite.api.weldpass.models.TotpCode
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.apiCall

/** A list as the screens show it: what was last loaded, and how loading went. */
data class Loadable<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val error: Throwable? = null,
)

/**
 * Vaults and items for the active workspace. Lists carry no secrets; a
 * revealed item is handed to the screen that asked and never kept here.
 */
class PassRepository(private val env: AppEnvironment) {
    private val api: DefaultApi get() = env.api.create()

    private val vaultState = MutableStateFlow(Loadable<List<Vault>>())
    private val itemState = MutableStateFlow(Loadable<List<Item>>())
    private var workspace: String? = null

    val vaults: StateFlow<Loadable<List<Vault>>> = vaultState.asStateFlow()
    val items: StateFlow<Loadable<List<Item>>> = itemState.asStateFlow()

    /** Forget another workspace's lists the moment the workspace changes. */
    fun useWorkspace(id: String) {
        if (workspace == id) return
        workspace = id
        vaultState.value = Loadable()
        itemState.value = Loadable()
    }

    suspend fun refresh() {
        val forWorkspace = workspace
        vaultState.update { it.copy(loading = true) }
        itemState.update { it.copy(loading = true) }
        val vaults = runCatching { apiCall { api.listVaults() }.data }
        val items = runCatching { apiCall { api.listItems() }.data }
        if (workspace != forWorkspace) return
        vaultState.value = vaults.fold(
            onSuccess = { Loadable(it) },
            onFailure = { Loadable(vaultState.value.data, error = it) },
        )
        itemState.value = items.fold(
            onSuccess = { Loadable(it) },
            onFailure = { Loadable(itemState.value.data, error = it) },
        )
    }

    /** The item's secret fields. Each call is a reveal the server audits. */
    suspend fun reveal(vaultId: String, itemId: String): ItemFields =
        apiCall { api.revealItem(vaultId, itemId) }.data.fields

    suspend fun totp(vaultId: String, itemId: String): TotpCode =
        apiCall { api.generateTotp(vaultId, itemId) }.data

    fun clear() {
        workspace = null
        vaultState.value = Loadable()
        itemState.value = Loadable()
    }
}
