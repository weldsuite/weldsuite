package com.weldsuite.weldpass

import org.weldsuite.api.weldpass.models.HealthEntry
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.Vault
import java.net.URI
import java.text.Collator
import java.time.Instant
import java.util.Locale

/**
 * WeldPass's list rules, the same as the platform's and the React Native
 * app's (`@weldsuite/app-api-client/schemas/weldpass-items`).
 */
object PassLogic {
    /** Personal vault first, then shared vaults by name. */
    fun sortVaults(vaults: List<Vault>, locale: Locale = Locale.getDefault()): List<Vault> {
        val collator = collator(locale)
        return vaults.sortedWith { a, b ->
            when {
                a.kind != b.kind -> if (a.kind == Vault.Kind.PERSONAL) -1 else 1
                else -> collator.compare(a.name, b.name)
            }
        }
    }

    /**
     * The visible items, sorted by title. Every word of [query] has to match
     * somewhere in the title, username, site or URL: never a secret.
     */
    fun filterItems(
        items: List<Item>,
        query: String,
        type: Item.Type? = null,
        vaultId: String? = null,
        locale: Locale = Locale.getDefault(),
    ): List<Item> {
        val words = query.lowercase(locale).split(Regex("\\s+")).filter { it.isNotEmpty() }
        val collator = collator(locale)
        return items
            .filter { item ->
                if (vaultId != null && item.vaultId != vaultId) return@filter false
                if (type != null && item.type != type) return@filter false
                if (words.isEmpty()) return@filter true
                val haystack = listOfNotNull(item.title, item.subtitle, item.url, item.host)
                    .joinToString(" ")
                    .lowercase(locale)
                words.all { haystack.contains(it) }
            }
            .sortedWith { a, b -> collator.compare(a.title, b.title) }
    }

    /**
     * [items] in one group per vault, as the platform's Passwords page groups
     * them: the personal vault first, then shared vaults by name, and no group
     * for a vault with nothing to show. Items of a vault missing from [vaults]
     * come last, in a group without a vault.
     */
    fun groupByVault(items: List<Item>, vaults: List<Vault>, locale: Locale = Locale.getDefault()): List<Pair<Vault?, List<Item>>> {
        val byVault = items.groupBy { it.vaultId }
        val known = sortVaults(vaults, locale)
        val groups: List<Pair<Vault?, List<Item>>> = known.mapNotNull { vault -> byVault[vault.id]?.let { vault to it } }
        val knownIds = known.mapTo(HashSet()) { it.id }
        val orphans = items.filter { it.vaultId !in knownIds }
        return if (orphans.isEmpty()) groups else groups + (null to orphans)
    }

    /** Password issues, worst first, as the platform's health page orders them. */
    val issueOrder = listOf(HealthEntry.Issues.WEAK, HealthEntry.Issues.REUSED, HealthEntry.Issues.OLD)

    /**
     * The health report's logins in one group per issue, worst first, each
     * login under its worst issue only; no group for an issue nobody has.
     */
    fun groupByWorstIssue(entries: List<HealthEntry>): List<Pair<HealthEntry.Issues, List<HealthEntry>>> {
        val byWorst = entries.groupBy { entry -> issueOrder.firstOrNull { it in entry.issues } }
        return issueOrder.mapNotNull { issue -> byWorst[issue]?.let { issue to it } }
    }

    /** Editor and manager can add, change, move and delete items. */
    fun canEditVault(vault: Vault?): Boolean = vault?.role == Vault.Role.EDITOR || vault?.role == Vault.Role.MANAGER

    /** An admin looking at a shared vault they are not in: no items, only settings. */
    fun isNonMemberView(vault: Vault?): Boolean = vault != null && vault.role == null

    /**
     * Where a new item goes by default: the vault being looked at if the
     * caller may write to it, else their personal vault, else the first vault
     * they can write to.
     */
    fun defaultCreateVaultId(vaults: List<Vault>, selectedVaultId: String?): String? {
        val writable = vaults.filter(::canEditVault)
        writable.firstOrNull { it.id == selectedVaultId }?.let { return it.id }
        return (writable.firstOrNull { it.kind == Vault.Kind.PERSONAL } ?: writable.firstOrNull())?.id
    }

    /** "123456" → "123 456"; other lengths split in the middle. */
    fun formatTotpCode(code: String): String {
        if (code.length < 4) return code
        val half = (code.length + 1) / 2
        return "${code.substring(0, half)} ${code.substring(half)}"
    }

    /** Whole seconds until [expiresAt], never negative. 0 when it doesn't parse. */
    fun secondsUntil(expiresAt: String, nowMillis: Long = System.currentTimeMillis()): Int {
        val expires = runCatching { Instant.parse(expiresAt).toEpochMilli() }.getOrNull() ?: return 0
        val left = expires - nowMillis
        return if (left <= 0) 0 else ((left + 999) / 1000).toInt()
    }

    /**
     * A link target for an item's URL. A stored URL may lack a scheme
     * ("example.com/login"); anything not http(s) is refused, so a saved
     * `javascript:` URL never becomes a link.
     */
    fun safeHref(url: String?): String? {
        val trimmed = url?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val candidate = if (Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
            trimmed
        } else {
            "https://$trimmed"
        }
        return try {
            val uri = URI(candidate)
            val scheme = uri.scheme?.lowercase()
            if ((scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()) uri.toString() else null
        } catch (_: Exception) {
            null
        }
    }

    private fun collator(locale: Locale): Collator = Collator.getInstance(locale).apply { strength = Collator.PRIMARY }
}
