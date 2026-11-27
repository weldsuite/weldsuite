package com.weldsuite.weldcalendar

import org.junit.Assert.assertEquals
import org.junit.Test

class WeldCalendarTest {
    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldcalendar", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }
}
