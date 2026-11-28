package com.weldsuite.welddesk

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldDeskTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.welddesk", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
