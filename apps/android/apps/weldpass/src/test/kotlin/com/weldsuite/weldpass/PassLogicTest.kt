package com.weldsuite.weldpass

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.Vault
import java.time.Instant
import java.util.Locale

class PassLogicTest {
    private val locale = Locale.ENGLISH

    private fun vault(id: String, kind: Vault.Kind, name: String, role: Vault.Role? = Vault.Role.MANAGER) = Vault(
        id = id, kind = kind, ownerId = null, name = name, description = null, createdBy = null,
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", role = role,
    )

    private fun item(id: String, title: String, type: Item.Type = Item.Type.LOGIN, subtitle: String? = null, host: String? = null, vaultId: String = "v1") = Item(
        id = id, vaultId = vaultId, type = type, title = title, subtitle = subtitle, url = host?.let { "https://$it" },
        host = host, hasTotp = false, passwordChangedAt = null, version = 1, createdBy = null, updatedBy = null,
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `the personal vault comes first, then shared ones by name`() {
        val sorted = PassLogic.sortVaults(
            listOf(vault("b", Vault.Kind.SHARED, "beta"), vault("p", Vault.Kind.PERSONAL, "Personal"), vault("a", Vault.Kind.SHARED, "Alpha")),
            locale,
        )
        assertEquals(listOf("p", "a", "b"), sorted.map { it.id })
    }

    @Test
    fun `every word has to match a title, username or site`() {
        val items = listOf(
            item("1", "GitHub", subtitle = "gert", host = "github.com"),
            item("2", "GitLab", subtitle = "ops", host = "gitlab.com"),
            item("3", "Visa", type = Item.Type.CARD, subtitle = "•••• 4242"),
        )
        assertEquals(listOf("1"), PassLogic.filterItems(items, "git gert", locale = locale).map { it.id })
        assertEquals(listOf("1", "2"), PassLogic.filterItems(items, "  GIT ", locale = locale).map { it.id })
        assertEquals(listOf("3"), PassLogic.filterItems(items, "", type = Item.Type.CARD, locale = locale).map { it.id })
        assertEquals(listOf("1", "2", "3"), PassLogic.filterItems(items, "", locale = locale).map { it.id })
    }

    @Test
    fun `items of one vault only`() {
        val items = listOf(item("1", "A", vaultId = "v1"), item("2", "B", vaultId = "v2"))
        assertEquals(listOf("2"), PassLogic.filterItems(items, "", vaultId = "v2", locale = locale).map { it.id })
    }

    @Test
    fun `editors and managers may change a vault, viewers and non-members not`() {
        assertTrue(PassLogic.canEditVault(vault("v", Vault.Kind.SHARED, "x", Vault.Role.EDITOR)))
        assertTrue(PassLogic.canEditVault(vault("v", Vault.Kind.SHARED, "x", Vault.Role.MANAGER)))
        assertFalse(PassLogic.canEditVault(vault("v", Vault.Kind.SHARED, "x", Vault.Role.VIEWER)))
        assertFalse(PassLogic.canEditVault(vault("v", Vault.Kind.SHARED, "x", null)))
        assertTrue(PassLogic.isNonMemberView(vault("v", Vault.Kind.SHARED, "x", null)))
        assertFalse(PassLogic.isNonMemberView(null))
    }

    @Test
    fun `a new item goes in the chosen vault, else the personal one, else none`() {
        val personal = vault("p", Vault.Kind.PERSONAL, "Personal")
        val shared = vault("s", Vault.Kind.SHARED, "Team", Vault.Role.EDITOR)
        val viewer = vault("v", Vault.Kind.SHARED, "Read", Vault.Role.VIEWER)
        assertEquals("s", PassLogic.defaultCreateVaultId(listOf(shared, personal), "s"))
        assertEquals("p", PassLogic.defaultCreateVaultId(listOf(shared, personal), "v"))
        assertNull(PassLogic.defaultCreateVaultId(listOf(viewer), null))
    }

    @Test
    fun `two-factor codes are split in the middle`() {
        assertEquals("123 456", PassLogic.formatTotpCode("123456"))
        assertEquals("1234 567", PassLogic.formatTotpCode("1234567"))
        assertEquals("123", PassLogic.formatTotpCode("123"))
    }

    @Test
    fun `seconds left round up and never go negative`() {
        val now = Instant.parse("2026-11-26T10:00:00Z").toEpochMilli()
        assertEquals(30, PassLogic.secondsUntil("2026-11-26T10:00:30Z", now))
        assertEquals(1, PassLogic.secondsUntil("2026-11-26T10:00:00.200Z", now))
        assertEquals(0, PassLogic.secondsUntil("2026-11-26T09:59:00Z", now))
        assertEquals(0, PassLogic.secondsUntil("soon", now))
    }

    @Test
    fun `only http and https links are opened`() {
        assertEquals("https://example.com/login", PassLogic.safeHref("example.com/login"))
        assertEquals("http://example.com", PassLogic.safeHref(" http://example.com "))
        assertNull(PassLogic.safeHref("javascript:alert(1)"))
        assertNull(PassLogic.safeHref("ftp://example.com"))
        assertNull(PassLogic.safeHref(""))
        assertNull(PassLogic.safeHref(null))
    }
}
