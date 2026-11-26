package com.weldsuite.weldpass.offline

import kotlinx.serialization.Serializable
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.SyncResult
import org.weldsuite.api.weldpass.models.SyncedItem
import org.weldsuite.api.weldpass.models.SyncedVault
import org.weldsuite.api.weldpass.models.Vault

/**
 * The offline copy of the vaults (ADR PASS-010), as it lives in memory once
 * opened, and the rules for applying a sync to it. Pure, so the merge is
 * tested directly. The same JSON as the Expo app's `lib/offline/copy.ts`, so
 * the native autofill reads either.
 *
 * One copy per workspace, bound to the server, the person and the device it
 * was synced for: a copy that names anything else is never read.
 */
@Serializable
data class OfflineCopy(
    val version: Int = COPY_VERSION,
    /** The server's origin (`https://app.weldsuite.eu`). */
    val server: String,
    val userId: String,
    val workspaceId: String,
    val deviceId: String,
    /** The server's clock at the last sync; empty before the first. */
    val syncedAt: String = "",
    val vaults: Map<String, CopiedVault> = emptyMap(),
) {
    fun owner(): CopyOwner = CopyOwner(server, userId, workspaceId, deviceId)

    companion object {
        const val COPY_VERSION = 1
    }
}

@Serializable
data class CopiedVault(
    val vault: Vault,
    val cursor: String,
    val items: Map<String, SyncedItem>,
)

/** Who and where a copy belongs to. */
data class CopyOwner(val server: String, val userId: String, val workspaceId: String, val deviceId: String)

sealed interface SyncOutcome {
    data class Wiped(val reason: SyncResult.Reason?) : SyncOutcome
    data class Updated(val copy: OfflineCopy, val removedVaultIds: Set<String>) : SyncOutcome
}

object CopyRules {
    fun empty(owner: CopyOwner): OfflineCopy =
        OfflineCopy(server = owner.server, userId = owner.userId, workspaceId = owner.workspaceId, deviceId = owner.deviceId)

    /** Whether a copy read from storage belongs to [owner]. */
    fun belongsTo(copy: OfflineCopy, owner: CopyOwner): Boolean =
        copy.version == OfflineCopy.COPY_VERSION && copy.owner() == owner

    /** The cursors to send: one per vault the copy holds. */
    fun cursorsOf(copy: OfflineCopy?): Map<String, String> = copy?.vaults?.mapValues { it.value.cursor }.orEmpty()

    /**
     * Apply a sync. The server lists every vault the person can read now, so
     * a vault the copy holds but the answer leaves out is dropped as well as
     * the ones named in `removedVaultIds`.
     */
    fun apply(copy: OfflineCopy, result: SyncResult): SyncOutcome {
        if (result.wipe) return SyncOutcome.Wiped(result.reason)
        val readable = result.vaults.map { it.vault.id }.toSet()
        val removed = result.removedVaultIds.toMutableSet()
        copy.vaults.keys.filterNotTo(removed) { it in readable }
        val vaults = result.vaults.associate { entry -> entry.vault.id to merge(copy.vaults[entry.vault.id], entry) }
        return SyncOutcome.Updated(copy.copy(syncedAt = result.syncedAt, vaults = vaults), removed)
    }

    /** One vault of a sync over what the copy held of it: replaced when `full`, else merged. */
    private fun merge(previous: CopiedVault?, entry: SyncedVault): CopiedVault {
        val items = if (entry.full || previous == null) mutableMapOf() else previous.items.toMutableMap()
        entry.deletedIds.forEach { items.remove(it) }
        entry.items.forEach { items[it.id] = it }
        return CopiedVault(vault = entry.vault, cursor = entry.cursor, items = items)
    }

    /** The vaults, as the vault list returns them, with their item counts from the copy. */
    fun vaultsOf(copy: OfflineCopy): List<Vault> = copy.vaults.values.map { it.vault.copy(itemCount = it.items.size) }

    /** Every item, as the item list returns them: the metadata, never the fields. */
    fun itemsOf(copy: OfflineCopy): List<Item> = copy.vaults.values.flatMap { vault -> vault.items.values.map(::summary) }

    fun find(copy: OfflineCopy, vaultId: String, itemId: String): SyncedItem? = copy.vaults[vaultId]?.items?.get(itemId)

    private fun summary(item: SyncedItem): Item = Item(
        id = item.id,
        vaultId = item.vaultId,
        type = Item.Type.entries.firstOrNull { it.value == item.type.value } ?: Item.Type.LOGIN,
        title = item.title,
        subtitle = item.subtitle,
        url = item.url,
        host = item.host,
        hasTotp = item.hasTotp,
        passwordChangedAt = item.passwordChangedAt,
        version = item.version,
        createdBy = item.createdBy,
        updatedBy = item.updatedBy,
        createdAt = item.createdAt,
        updatedAt = item.updatedAt,
    )
}
