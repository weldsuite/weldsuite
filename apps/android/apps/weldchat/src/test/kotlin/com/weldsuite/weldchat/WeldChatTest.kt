package com.weldsuite.weldchat

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldChatTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldchat", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
