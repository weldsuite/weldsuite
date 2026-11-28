package com.weldsuite.weldhr

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldHRTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldhr", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
