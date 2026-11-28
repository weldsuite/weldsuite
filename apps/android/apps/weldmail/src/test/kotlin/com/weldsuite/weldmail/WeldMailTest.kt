package com.weldsuite.weldmail

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldMailTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldmail", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
