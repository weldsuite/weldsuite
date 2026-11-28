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
     * The browsers whose page domain is believed. Any app can put a domain on
     * its own views (`ViewStructure.setWebDomain`), so one claiming to be
     * `yourbank.com` would be handed that login; a domain from any other app
     * is ignored, and its screen is matched by its package name instead.
     */
    val BROWSERS: Set<String> = setOf(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.chrome.canary",
        "org.chromium.chrome",
        "org.mozilla.firefox",
        "org.mozilla.firefox_beta",
        "org.mozilla.fenix",
        "org.mozilla.focus",
        "org.mozilla.klar",
        "com.microsoft.emmx",
        "com.microsoft.emmx.beta",
        "com.brave.browser",
        "com.brave.browser_beta",
        "com.sec.android.app.sbrowser",
        "com.sec.android.app.sbrowser.beta",
        "com.opera.browser",
        "com.opera.browser.beta",
        "com.opera.gx",
        "com.vivaldi.browser",
        "com.duckduckgo.mobile.android",
        "com.kiwibrowser.browser",
        "com.ecosia.android",
        "org.torproject.torbrowser",
    )

    /**
     * The page domain to match on: what a known browser ([BROWSERS]) reports
     * for a page served over https (or on localhost), lower-cased and without
     * `www.`; null for anything else. `webScheme` is null where Android
     * doesn't report one (before Android 9, or a domain given without it).
     */
    fun trustedDomain(webDomain: String?, webScheme: String?, packageName: String): String? {
        val domain = webDomain?.trim()?.lowercase()?.removePrefix("www.")?.takeIf { it.isNotEmpty() } ?: return null
        if (packageName !in BROWSERS) return null
        if (isInsecure(domain, webScheme)) return null
        return domain
    }

    /** A page in a known browser that is not https (localhost aside): WeldPass offers nothing there. */
    fun isInsecurePage(webDomain: String?, webScheme: String?, packageName: String): Boolean {
        val domain = webDomain?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        return packageName in BROWSERS && isInsecure(domain, webScheme)
    }

    private fun isInsecure(domain: String, webScheme: String?): Boolean =
        webScheme != null && !webScheme.equals("https", ignoreCase = true) && domain != "localhost"

    /**
     * The logins for this screen: an app's own by package name (stored in the
     * sealed item, matched only here), a page's by domain, with the
     * platform's `hostsMatch` rule. `webDomain` is the one [trustedDomain]
     * believed, never a domain an app reported for itself.
     */
    fun matching(logins: List<AutofillLogin>, webDomain: String?, packageName: String): List<AutofillLogin> {
        val domain = webDomain?.removePrefix("www.")
        return logins.filter { login ->
            if (domain != null) login.host?.let { hostsMatch(it, domain) } ?: false else packageName in login.apps
        }
    }

    /**
     * What the unlock offers: a single login that matches this screen is
     * filled straight away; several are listed; with none, every login is
     * listed with its site, and one is filled only when the person picks it.
     */
    fun choices(logins: List<AutofillLogin>, webDomain: String?, packageName: String): Choices {
        val matching = matching(logins, webDomain, packageName)
        return when {
            matching.size == 1 -> Choices(matching, fillAtOnce = true)
            matching.isNotEmpty() -> Choices(matching, fillAtOnce = false)
            else -> Choices(logins, fillAtOnce = false)
        }
    }

    data class Choices(val logins: List<AutofillLogin>, val fillAtOnce: Boolean)

    /** A row of the list: title, username and the login's site, so a login for another site is seen as one. */
    fun label(login: AutofillLogin): String =
        listOfNotNull(login.title, login.username, login.host).filter(String::isNotEmpty).joinToString(" · ")

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
