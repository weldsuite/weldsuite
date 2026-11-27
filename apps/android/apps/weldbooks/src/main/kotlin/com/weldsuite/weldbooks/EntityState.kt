package com.weldsuite.weldbooks

import android.content.Context
import androidx.core.content.edit
import com.weldsuite.weldbooks.logic.Entity
import com.weldsuite.weldbooks.logic.Jurisdiction
import com.weldsuite.weldbooks.logic.resolveActiveEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The companies (accounting entities) of the workspace and the one whose books
 * are open. Every WeldBooks route is scoped to one, so the app shows the setup
 * door until there is one. The choice is kept per workspace and sent as
 * `X-Accounting-Entity-Id`. Only the first load gates the app: a failed
 * refresh keeps what was loaded.
 */
class EntityState(context: Context, private val repository: BooksRepository) {
    data class Snapshot(
        val loading: Boolean = true,
        val failed: Boolean = false,
        val refreshing: Boolean = false,
        val entities: List<Entity> = emptyList(),
        val activeId: String? = null,
        val jurisdictions: List<Jurisdiction>? = null,
        val switcherOpen: Boolean = false,
    ) {
        val active: Entity? get() = entities.firstOrNull { it.id == activeId }
        val hasEntity: Boolean get() = entities.isNotEmpty()
        val canSwitch: Boolean get() = entities.size > 1
    }

    private val prefs = context.applicationContext.getSharedPreferences("weldbooks.entities", Context.MODE_PRIVATE)
    private val state = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = state.asStateFlow()
    private var workspace: String? = null
    private var loaded = false

    /** Start over for [workspaceId]: entities are per workspace. */
    suspend fun use(workspaceId: String) {
        if (workspace == workspaceId && loaded) return
        workspace = workspaceId
        loaded = false
        repository.entityId = null
        state.value = Snapshot(jurisdictions = state.value.jurisdictions)
        load()
        loadJurisdictions()
    }

    suspend fun load() {
        val forWorkspace = workspace ?: return
        if (loaded) state.update { it.copy(refreshing = true) }
        val result = runCatching { repository.entities() }
        if (workspace != forWorkspace) return
        result.onSuccess { rows ->
            val active = rows.filter { it.isActive }
            val stored = prefs.getString(key(forWorkspace), null)
            val resolved = resolveActiveEntity(active, state.value.activeId ?: stored, { it.id }, { it.isDefault })
            repository.entityId = resolved?.id
            if (resolved != null && resolved.id != stored) prefs.edit { putString(key(forWorkspace), resolved.id) }
            loaded = true
            state.update { it.copy(loading = false, failed = false, refreshing = false, entities = active, activeId = resolved?.id) }
        }.onFailure {
            state.update { it.copy(loading = false, failed = !loaded, refreshing = false) }
        }
    }

    /** The supported countries; the built-in table answers until (or unless) they load. */
    private suspend fun loadJurisdictions() {
        if (state.value.jurisdictions != null) return
        runCatching { repository.jurisdictions() }.onSuccess { list -> state.update { it.copy(jurisdictions = list) } }
    }

    fun select(id: String) {
        val forWorkspace = workspace ?: return
        repository.entityId = id
        prefs.edit { putString(key(forWorkspace), id) }
        state.update { it.copy(activeId = id, switcherOpen = false) }
    }

    /** A company that was just created: add it and open its books. */
    fun adopt(entity: Entity) {
        state.update { current ->
            val entities = if (current.entities.any { it.id == entity.id }) current.entities else current.entities + entity
            current.copy(entities = entities)
        }
        select(entity.id)
    }

    fun openSwitcher() = state.update { it.copy(switcherOpen = true) }

    fun closeSwitcher() = state.update { it.copy(switcherOpen = false) }

    fun clear() {
        workspace = null
        loaded = false
        repository.entityId = null
        state.value = Snapshot(jurisdictions = state.value.jurisdictions)
    }

    private fun key(workspaceId: String) = "active.$workspaceId"
}
