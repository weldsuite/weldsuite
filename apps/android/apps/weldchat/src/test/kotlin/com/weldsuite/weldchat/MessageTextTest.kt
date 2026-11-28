package com.weldsuite.weldchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class MessageTextTest {
    private val names = mapOf("u_ann" to "Ann")

    private fun message(
        id: String,
        content: String = "",
        type: String = "text",
        author: String = "u_ann",
        createdAt: String = "2026-11-27T10:00:00Z",
        pending: Boolean = false,
    ) = ChatMessage(id = id, channelId = "ch_1", authorId = author, authorName = author, content = content, type = type, createdAt = createdAt, pending = pending)

    @Test
    fun mentionsReadAsNamesAndFilesDropOut() {
        val text = "Hi <@u_ann>, see <@file:f_1> and <@u_bob|Bob> or <@agt_1:Helper> <@u_x>"
        assertEquals("Hi @Ann, see  and @Bob or @Helper @unknown", MentionText.plainText(text, names))
        assertEquals("a  b", MentionText.stripFileTokens("a <@file:f_1> b"))
        assertEquals(listOf("f_1", "f_2"), MentionText.fileTokenIds("<@file:f_1><@file:f_2><@file:f_1><@file:>"))
        assertNull(MentionText.fileTokenId("file:"))
        assertTrue(MentionText.isAgentId("agt_1"))
        assertFalse(MentionText.isAgentId("u_1"))
    }

    @Test
    fun aBodySplitsAroundItsInlineFiles() {
        val blocks = MentionText.blocks("Look:\n<@file:f_1>\nand this <@file:f_gone>\n<@file:f_2>", setOf("f_1", "f_2"))
        assertEquals(
            listOf(MessageBlock.Text("Look:"), MessageBlock.File("f_1"), MessageBlock.Text("and this "), MessageBlock.File("f_2")),
            blocks,
        )
        assertEquals(listOf(MessageBlock.Text("plain")), MentionText.blocks("plain", emptySet()))
        assertEquals(emptyList<MessageBlock>(), MentionText.blocks("  ", emptySet()))
    }

    @Test
    fun runsMarkMentionsAndLinks() {
        val runs = MentionText.runs("Ask <@u_ann> on www.weldsuite.eu, or https://x.test/a).", names)
        assertEquals(
            listOf(
                TextRun.Plain("Ask "),
                TextRun.Mention("@Ann"),
                TextRun.Plain(" on "),
                TextRun.Link("www.weldsuite.eu", "https://www.weldsuite.eu"),
                TextRun.Plain(", or "),
                TextRun.Link("https://x.test/a", "https://x.test/a"),
                TextRun.Plain(")."),
            ),
            runs,
        )
    }

    @Test
    fun theMentionPickerFollowsTheTrailingAt() {
        assertEquals("an", MentionText.mentionQuery("Hi @an"))
        assertEquals("", MentionText.mentionQuery("@"))
        assertNull("an e-mail address isn't a mention", MentionText.mentionQuery("mail ann@example"))
        assertNull(MentionText.mentionQuery("Hi @ann "))
        assertEquals("Hi <@u_ann> ", MentionText.insertMention("Hi @an", "u_ann"))
        assertEquals("no mention", MentionText.insertMention("no mention", "u_ann"))
    }

    @Test
    fun callMessagesParse() {
        assertEquals(CallEvent.Start(isVideo = true), CallLog.parse("Ann started a video call"))
        assertEquals(CallEvent.Start(isVideo = false), CallLog.parse("Ann started a call"))
        assertEquals(CallEvent.Ended(isVideo = false, duration = "2m 34s"), CallLog.parse("Call ended — 2m 34s"))
        assertEquals(CallEvent.Ended(isVideo = true, duration = null), CallLog.parse("Call ended (video call)"))
        assertEquals(CallEvent.Missed(isVideo = false), CallLog.parse("Missed voice call"))
        assertNull(CallLog.parse("Ann joined the channel"))
        assertEquals(154, CallLog.seconds("2m 34s"))
        assertEquals(40, CallLog.seconds("40s"))
        assertNull(CallLog.seconds(null))
        assertEquals(UiText.Res(R.string.weldchat_channel_call_few_seconds), CallLog.lasted("40s"))
        assertEquals(UiText.Plural(R.plurals.weldchat_channel_call_minutes, 3), CallLog.lasted("2m 34s"))
        assertEquals(UiText.Plural(R.plurals.weldchat_channel_call_hours, 2), CallLog.lasted("100m"))
        assertNull(CallLog.lasted(""))
    }

    @Test
    fun aCallsEndFoldsIntoItsStart() {
        val built = CallLog.build(
            listOf(
                message("start", "Ann started a call", "system"),
                message("talk", "hello"),
                message("end", "Call ended — 1m 5s", "system"),
                message("lonely", "Missed video call", "system"),
                message("open", "Bob started a video call", "system", author = "u_bob"),
            ),
        )
        assertEquals(setOf("end"), built.folded)
        assertEquals(CallLogEntry.Outcome.ENDED, built.entries["start"]?.outcome)
        assertEquals("1m 5s", built.entries["start"]?.duration)
        assertEquals(CallLogEntry.Outcome.MISSED, built.entries["lonely"]?.outcome)
        assertTrue(built.entries["lonely"]?.isVideo == true)
        assertNull("still running", built.entries["open"]?.outcome)
        assertEquals("open", built.openId)
        assertNull(built.entries["talk"])
    }

    @Test
    fun messagesGroupByDayAndAuthor() {
        val zone = ZoneId.of("Europe/Amsterdam")
        val first = message("1", createdAt = "2026-11-27T10:00:00Z")
        val soon = message("2", createdAt = "2026-11-27T10:03:00Z")
        val later = message("3", createdAt = "2026-11-27T10:06:00Z")
        val nextDay = message("4", createdAt = "2026-11-28T10:00:00Z")
        assertTrue(MessageLayout.startsNewDay(first, null, zone))
        assertFalse(MessageLayout.startsNewDay(soon, first, zone))
        assertTrue(MessageLayout.startsNewDay(nextDay, later, zone))
        assertTrue(MessageLayout.isCompact(soon, first))
        assertFalse("more than five minutes", MessageLayout.isCompact(later, first))
        assertFalse("another author", MessageLayout.isCompact(soon, first.copy(authorId = "u_bob")))
        assertFalse("after a system message", MessageLayout.isCompact(soon, first.copy(type = "system")))
        assertFalse("a reply stands out", MessageLayout.isCompact(soon.copy(replyTo = ReplyReference("1", "1", 0, "", "", null, "", false)), first))
        assertEquals(listOf("1", "2", "3"), MessageLayout.chronological(listOf(later, first, soon)).map { it.id })
    }

    @Test
    fun aRefreshKeepsOlderPagesAndPendingSends() {
        val old = message("old", createdAt = "2026-11-27T08:00:00Z")
        val kept = message("a", createdAt = "2026-11-27T10:00:00Z")
        val stale = message("stale", createdAt = "2026-11-27T10:30:00Z")
        val pending = message("tmp", createdAt = "2026-11-27T11:00:00Z", pending = true)
        val merged = MessageLayout.merge(listOf(old, kept, stale, pending), listOf(kept, message("b", createdAt = "2026-11-27T10:45:00Z")), listOf(pending))
        assertEquals(listOf("old", "a", "b", "tmp"), merged.map { it.id })
    }
}
