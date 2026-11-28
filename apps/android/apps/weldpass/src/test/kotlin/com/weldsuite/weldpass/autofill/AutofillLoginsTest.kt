package com.weldsuite.weldpass.autofill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AutofillLoginsTest {
    private fun login(id: String, host: String? = null, apps: List<String> = emptyList()) =
        AutofillLogin("ws_1", "v1", id, id, host, "me", "pw", apps)

    @Test
    fun `hosts match exactly, by subdomain, and without www`() {
        assertTrue(AutofillLogins.hostsMatch("github.com", "github.com"))
        assertTrue(AutofillLogins.hostsMatch("github.com", "gist.github.com"))
        assertTrue(AutofillLogins.hostsMatch("www.github.com", "github.com"))
        assertFalse(AutofillLogins.hostsMatch("github.com", "notgithub.com"))
        assertFalse(AutofillLogins.hostsMatch("com", "github.com"))
    }

    @Test
    fun `a page matches by domain, an app by its package`() {
        val logins = listOf(
            login("web", host = "example.com"),
            login("app", apps = listOf("com.example.app")),
            login("other", host = "other.org"),
        )
        assertEquals(listOf("web"), AutofillLogins.matching(logins, "www.example.com", "com.android.chrome").map { it.itemId })
        assertEquals(listOf("app"), AutofillLogins.matching(logins, null, "com.example.app").map { it.itemId })
        assertTrue(AutofillLogins.matching(logins, null, "com.unknown").isEmpty())
    }

    @Test
    fun `a page domain is believed from a known browser only`() {
        assertEquals("example.com", AutofillLogins.trustedDomain("www.Example.com", "https", "com.android.chrome"))
        assertEquals("example.com", AutofillLogins.trustedDomain("example.com", null, "org.mozilla.firefox"))
        // Any app can report a domain for its own views.
        assertNull(AutofillLogins.trustedDomain("yourbank.com", "https", "com.evil.app"))
        assertNull(AutofillLogins.trustedDomain("yourbank.com", null, "com.evil.app"))
        assertNull(AutofillLogins.trustedDomain(null, "https", "com.android.chrome"))
        assertNull(AutofillLogins.trustedDomain("  ", "https", "com.android.chrome"))
    }

    @Test
    fun `a browser page that is not https gets nothing, localhost aside`() {
        assertNull(AutofillLogins.trustedDomain("example.com", "http", "com.android.chrome"))
        assertTrue(AutofillLogins.isInsecurePage("example.com", "http", "com.android.chrome"))
        assertFalse(AutofillLogins.isInsecurePage("example.com", "https", "com.android.chrome"))
        assertFalse(AutofillLogins.isInsecurePage("example.com", null, "com.android.chrome"))
        assertEquals("localhost", AutofillLogins.trustedDomain("localhost", "http", "com.android.chrome"))
        assertFalse(AutofillLogins.isInsecurePage("localhost", "http", "com.android.chrome"))
        // An app's own claim is ignored rather than refused: it is matched by package.
        assertFalse(AutofillLogins.isInsecurePage("example.com", "http", "com.example.app"))
    }

    @Test
    fun `an app claiming a site's domain is offered nothing of that site's unasked`() {
        val logins = listOf(login("bank", host = "yourbank.com"))
        val domain = AutofillLogins.trustedDomain("yourbank.com", "https", "com.evil.app")
        val choices = AutofillLogins.choices(logins, domain, "com.evil.app")
        // Listed, with its site, for the person to pick, never filled straight away.
        assertFalse(choices.fillAtOnce)
        assertEquals(listOf("bank"), choices.logins.map { it.itemId })
        assertEquals("bank · me · yourbank.com", AutofillLogins.label(choices.logins.first()))
    }

    @Test
    fun `only a single matching login is filled at once`() {
        val logins = listOf(login("web", host = "example.com"), login("other", host = "other.org"))
        val one = AutofillLogins.choices(logins, "example.com", "com.android.chrome")
        assertTrue(one.fillAtOnce)
        assertEquals(listOf("web"), one.logins.map { it.itemId })

        val two = AutofillLogins.choices(logins + login("web2", host = "login.example.com"), "example.com", "com.android.chrome")
        assertFalse(two.fillAtOnce)
        assertEquals(setOf("web", "web2"), two.logins.map { it.itemId }.toSet())

        val none = AutofillLogins.choices(listOf(login("other", host = "other.org")), "example.com", "com.android.chrome")
        assertFalse(none.fillAtOnce)
        assertEquals(listOf("other"), none.logins.map { it.itemId })

        assertTrue(AutofillLogins.choices(emptyList(), "example.com", "com.android.chrome").logins.isEmpty())
    }
}
