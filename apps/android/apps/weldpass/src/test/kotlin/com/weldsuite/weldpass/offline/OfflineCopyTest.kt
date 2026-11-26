package com.weldsuite.weldpass.offline

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.weldpass.models.DeviceEvent
import org.weldsuite.api.weldpass.models.ItemFields
import org.weldsuite.api.weldpass.models.SyncResult
import org.weldsuite.api.weldpass.models.SyncedItem
import org.weldsuite.api.weldpass.models.SyncedVault
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.core.WeldJson
import org.weldsuite.core.storage.MemoryStore

class OfflineCopyTest {
    private val owner = CopyOwner("https://app.weldsuite.eu", "user_1", "ws_1", "dev_1")

    private fun vault(id: String) = Vault(
        id = id, kind = Vault.Kind.SHARED, ownerId = null, name = id, description = null, createdBy = null,
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", role = Vault.Role.EDITOR,
    )

    private fun item(id: String, vaultId: String, password: String = "pw") = SyncedItem(
        id = id, vaultId = vaultId, type = SyncedItem.Type.LOGIN, title = id, subtitle = "me", url = null, host = null,
        hasTotp = false, passwordChangedAt = null, version = 1, createdBy = null, updatedBy = null,
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
        fields = ItemFields(username = "me", password = password, totp = "", notes = ""),
    )

    private fun synced(vaultId: String, full: Boolean, items: List<SyncedItem>, deleted: List<String> = emptyList()) =
        SyncedVault(vault = vault(vaultId), cursor = "c-$vaultId-${items.size}", full = full, items = items, deletedIds = deleted)

    private fun result(vararg vaults: SyncedVault, removed: List<String> = emptyList()) =
        SyncResult(wipe = false, reason = null, syncedAt = "2026-11-26T10:00:00Z", vaults = vaults.toList(), removedVaultIds = removed)

    private fun updated(outcome: SyncOutcome) = outcome as SyncOutcome.Updated

    @Test
    fun `a first sync fills the copy and sets its cursors`() {
        val copy = updated(CopyRules.apply(CopyRules.empty(owner), result(synced("v1", true, listOf(item("a", "v1")))))).copy
        assertEquals(setOf("a"), copy.vaults["v1"]!!.items.keys)
        assertEquals(mapOf("v1" to "c-v1-1"), CopyRules.cursorsOf(copy))
        assertEquals("2026-11-26T10:00:00Z", copy.syncedAt)
    }

    @Test
    fun `a later sync merges changes and deletions, a full one replaces`() {
        val first = updated(CopyRules.apply(CopyRules.empty(owner), result(synced("v1", true, listOf(item("a", "v1"), item("b", "v1")))))).copy
        val merged = updated(CopyRules.apply(first, result(synced("v1", false, listOf(item("a", "v1", "new"), item("c", "v1")), listOf("b"))))).copy
        assertEquals(setOf("a", "c"), merged.vaults["v1"]!!.items.keys)
        assertEquals("new", merged.vaults["v1"]!!.items["a"]!!.fields.password)
        val replaced = updated(CopyRules.apply(merged, result(synced("v1", true, listOf(item("z", "v1")))))).copy
        assertEquals(setOf("z"), replaced.vaults["v1"]!!.items.keys)
    }

    @Test
    fun `vaults the person can no longer read are dropped`() {
        val first = updated(CopyRules.apply(CopyRules.empty(owner), result(synced("v1", true, listOf(item("a", "v1"))), synced("v2", true, emptyList())))).copy
        val outcome = updated(CopyRules.apply(first, result(synced("v2", false, emptyList()), removed = listOf("v9"))))
        assertEquals(setOf("v2"), outcome.copy.vaults.keys)
        assertEquals(setOf("v1", "v9"), outcome.removedVaultIds)
    }

    @Test
    fun `the server can tell the phone to wipe`() {
        val wiped = CopyRules.apply(
            CopyRules.empty(owner),
            SyncResult(wipe = true, reason = SyncResult.Reason.REVOKED, syncedAt = "", vaults = emptyList(), removedVaultIds = emptyList()),
        )
        assertEquals(SyncOutcome.Wiped(SyncResult.Reason.REVOKED), wiped)
    }

    @Test
    fun `lists from the copy carry no fields and count items per vault`() {
        val copy = updated(CopyRules.apply(CopyRules.empty(owner), result(synced("v1", true, listOf(item("a", "v1"), item("b", "v1")))))).copy
        assertEquals(2, CopyRules.vaultsOf(copy).single().itemCount)
        assertEquals(listOf("a", "b"), CopyRules.itemsOf(copy).map { it.id }.sorted())
        assertEquals("pw", CopyRules.find(copy, "v1", "a")!!.fields.password)
        assertNull(CopyRules.find(copy, "v2", "a"))
    }

    @Test
    fun `a copy only belongs to its own server, person, workspace and device`() {
        val copy = CopyRules.empty(owner)
        assertTrue(CopyRules.belongsTo(copy, owner))
        assertTrue(!CopyRules.belongsTo(copy, owner.copy(deviceId = "dev_2")))
        assertTrue(!CopyRules.belongsTo(copy.copy(version = 2), owner))
    }

    @Test
    fun `the sealed file opens with its key and owner only`() {
        val key = ByteArray(32) { it.toByte() }
        val copy = updated(CopyRules.apply(CopyRules.empty(owner), result(synced("v1", true, listOf(item("a", "v1")))))).copy
        val json = WeldJson.encodeToString(OfflineCopy.serializer(), copy)
        val file = CopyEnvelope.seal(json, owner, AesGcmCipher(key))
        assertEquals("WPO1", String(file.copyOfRange(0, 4), Charsets.US_ASCII))
        assertEquals(json, CopyEnvelope.open(file, owner, AesGcmCipher(key)))
        assertThrows(Exception::class.java) { CopyEnvelope.open(file, owner.copy(workspaceId = "ws_2"), AesGcmCipher(key)) }
        assertThrows(Exception::class.java) { CopyEnvelope.open(file, owner, AesGcmCipher(ByteArray(32))) }
        assertNull(CopyEnvelope.open(byteArrayOf(1, 2, 3), owner, AesGcmCipher(key)))
    }

    @Test
    fun `queued events upload in batches and keep what failed`() = runTest {
        val queue = EventQueue(MemoryStore())
        repeat(1200) { queue.add("ws_1", DeviceEvent("v1", "i$it", DeviceEvent.Action.COPIED, "2026-11-26T10:00:00Z")) }
        val batches = mutableListOf<Int>()
        queue.flush("ws_1") { batches += it.size }
        assertEquals(listOf(500, 500, 200), batches)
        assertTrue(queue.read("ws_1").isEmpty())

        repeat(3) { queue.add("ws_1", DeviceEvent("v1", "i$it", DeviceEvent.Action.REVEALED, "2026-11-26T10:00:00Z")) }
        runCatching { queue.flush("ws_1") { error("offline") } }
        assertEquals(3, queue.read("ws_1").size)
    }
}
