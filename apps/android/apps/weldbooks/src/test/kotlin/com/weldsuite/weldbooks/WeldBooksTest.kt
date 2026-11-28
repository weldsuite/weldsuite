package com.weldsuite.weldbooks

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldBooksTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldbooks", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
