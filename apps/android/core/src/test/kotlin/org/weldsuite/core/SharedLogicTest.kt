package org.weldsuite.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.push.PushPayload
import org.weldsuite.core.realtime.realtimeBase
import org.weldsuite.core.realtime.realtimeTopicMatches
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** The realtime, push and formatting helpers the apps share. */
class SharedLogicTest {
    @Test
    fun realtimeBaseDropsTheWsSuffixAndFallsBackToTheServer() {
        assertEquals("wss://app.test.weldsuite.eu", realtimeBase("wss://app.test.weldsuite.eu/ws", "https://app.weldsuite.eu"))
        assertEquals("wss://rt.example.com", realtimeBase("wss://rt.example.com/", "https://app.weldsuite.eu"))
        assertEquals("wss://app.weldsuite.eu", realtimeBase(null, "https://app.weldsuite.eu"))
        assertEquals("wss://app.weldsuite.eu", realtimeBase("  ", "https://app.weldsuite.eu"))
    }

    @Test
    fun aTopicMatchesItselfAndItsChildren() {
        assertTrue(realtimeTopicMatches("ticket", "ticket"))
        assertTrue(realtimeTopicMatches("ticket.tkt_1", "ticket"))
        assertFalse(realtimeTopicMatches("tickets", "ticket"))
        assertFalse(realtimeTopicMatches("ticket", "ticket.tkt_1"))
    }

    @Test
    fun aPushPayloadReadsEmptyValuesAsAbsent() {
        val payload = PushPayload(mapOf("notificationType" to "chat_dm", "entityId" to "", "chatChannelId" to "ch_1"))
        assertEquals("chat_dm", payload.notificationType)
        assertNull(payload.entityId)
        assertEquals("ch_1", payload["chatChannelId"])
    }

    @Test
    fun timestampsAndDaysParse() {
        val expected = Instant.parse("2026-11-27T09:30:00Z")
        assertEquals(expected, WeldDate.parse("2026-11-27T09:30:00.000Z"))
        assertEquals(expected, WeldDate.parse("2026-11-27T09:30:00+00:00"))
        assertEquals(expected, WeldDate.parse("2026-11-27 09:30:00"))
        assertEquals(Instant.parse("2026-11-27T00:00:00Z"), WeldDate.parse("2026-11-27", ZoneOffset.UTC))
        assertNull(WeldDate.parse(""))
        assertNull(WeldDate.parse("not a date"))
        assertEquals(LocalDate.of(2026, 11, 27), WeldDate.day("2026-11-27T23:59:00Z"))
        assertEquals("2026-11-27", WeldDate.dayString(LocalDate.of(2026, 11, 27)))
    }

    @Test
    fun moneyParsesDecimalStringsAndWritesTwoDecimals() {
        assertEquals(BigDecimal("1250.50"), Money.parse("1250.50"))
        assertNull(Money.parse("abc"))
        assertNull(Money.parse(null))
        assertEquals("12.35", Money.apiString(BigDecimal("12.345")))
        assertEquals("10.00", Money.apiString(BigDecimal.TEN))
    }

    @Test
    fun errorMessagesFollowTheFailure() {
        assertEquals(R.string.core_errors_offline, apiErrorMessage(ApiException(null, null, null)))
        assertEquals(R.string.core_errors_forbidden, apiErrorMessage(ApiException(403, null, null)))
        assertEquals(R.string.core_errors_not_found, apiErrorMessage(ApiException(404, null, null)))
        assertEquals(R.string.core_errors_generic, apiErrorMessage(ApiException(500, null, null)))
        assertEquals(R.string.core_errors_generic, apiErrorMessage(IllegalStateException()))
    }

    @Test
    fun aLoadStateIsAFirstLoadUntilDataOrAnErrorArrives() {
        assertTrue(LoadState<List<Int>>().isFirstLoad)
        assertFalse(LoadState(data = listOf(1)).isFirstLoad)
        assertFalse(LoadState<List<Int>>(error = ApiException(null, null, null)).isFirstLoad)
    }
}
