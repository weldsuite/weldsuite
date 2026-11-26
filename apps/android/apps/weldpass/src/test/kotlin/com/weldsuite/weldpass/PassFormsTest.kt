package com.weldsuite.weldpass

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.ItemInput

class PassFormsTest {
    @Test
    fun `a login sends only its own fields, and no apps when there are none`() {
        val input = PassForms.toInput(
            ItemFormValues(
                type = Item.Type.LOGIN, vaultId = "v1", title = "  GitHub ", url = " ", username = "gert",
                password = "pw", totp = " JBSW ", number = "4242", content = "stale",
            ),
        )
        assertEquals(ItemInput.Type.LOGIN, input.type)
        assertEquals("GitHub", input.title)
        assertNull(input.url)
        assertEquals("gert", input.fields.username)
        assertEquals("JBSW", input.fields.totp)
        assertNull(input.fields.number)
        assertNull(input.fields.content)
        assertNull(input.fields.apps)
    }

    @Test
    fun `a card sends its card fields and notes`() {
        val input = PassForms.toInput(
            ItemFormValues(type = Item.Type.CARD, vaultId = "v1", title = "Visa", number = " 4242 ", username = "stale"),
        )
        assertEquals(ItemInput.Type.CARD, input.type)
        assertEquals("4242", input.fields.number)
        assertEquals("", input.fields.notes)
        assertNull(input.fields.username)
        assertNull(input.url)
    }

    @Test
    fun `a note sends only its content`() {
        val input = PassForms.toInput(ItemFormValues(type = Item.Type.NOTE, vaultId = "v1", title = "Wifi", content = "hello"))
        assertEquals("hello", input.fields.content)
        assertNull(input.fields.notes)
    }

    @Test
    fun `app lists are split, trimmed and checked`() {
        val apps = PassForms.parseAppList("com.example.app\n com.example.app, org.test;not a package")
        assertEquals(listOf("com.example.app", "org.test", "not", "a", "package"), apps)
        assertEquals(listOf("not", "a", "package"), PassForms.invalidApps(apps))
    }

    @Test
    fun `strength follows the platform's thresholds`() {
        assertEquals(Strength.WEAK, PassForms.strength("password"))
        assertEquals(Strength.WEAK, PassForms.strength("abcdefgh"))
        assertEquals(0.0, PassForms.entropyBits(""), 0.0)
        assertEquals(Strength.STRONG, PassForms.strength("k7#Pq9!mZ2@wX4^v"))
    }

    @Test
    fun `generated passwords have the requested length and every chosen class`() {
        repeat(50) {
            val password = PassForms.generatePassword(length = 12)
            assertEquals(12, password.length)
            assertTrue(password.any { it.isLowerCase() })
            assertTrue(password.any { it.isUpperCase() })
            assertTrue(password.any { it.isDigit() })
            assertTrue(password.any { !it.isLetterOrDigit() })
            assertTrue(password.none { it in "l1IO0" })
        }
        val plain = PassForms.generatePassword(length = 3, uppercase = false, digits = false, symbols = false)
        assertEquals(8, plain.length)
        assertTrue(plain.all { it.isLowerCase() })
    }
}
