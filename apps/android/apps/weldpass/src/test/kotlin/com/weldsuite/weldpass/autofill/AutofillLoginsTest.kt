package com.weldsuite.weldpass.autofill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
