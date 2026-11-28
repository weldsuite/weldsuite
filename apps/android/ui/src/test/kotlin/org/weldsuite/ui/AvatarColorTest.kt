package org.weldsuite.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** The hash must match the web platform's, so a person has the same colour everywhere. */
class AvatarColorTest {
    @Test
    fun matchesThePlatformsHash() {
        // Values from the platform's hashString in Node.
        assertEquals(9_689_464_202L, platformHash("e2e-visitor@example.com"))
        assertEquals(1_453_002_847L, platformHash("gert@weldhost.com"))
        assertEquals(483_627_419L, platformHash("Ann de Vries"))
        assertEquals(4_093_051_470L, platformHash("Zoë 😀 Müller"))
        assertEquals(0L, platformHash(""))
    }
}
