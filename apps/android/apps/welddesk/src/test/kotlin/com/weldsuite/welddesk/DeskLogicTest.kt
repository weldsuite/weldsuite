package com.weldsuite.welddesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneOffset

class DeskLogicTest {
    private fun conversation(
        name: String? = null,
        email: String? = null,
        title: String? = null,
        preview: String? = null,
        waiting: Boolean = false,
        lastMessageAt: Instant? = null,
        updatedAt: Instant? = Instant.parse("2026-11-27T09:00:00Z"),
    ) = Conversation(
        id = "dconv_1",
        number = 42,
        title = title,
        state = ConversationState.OPEN,
        channel = DeskChannel.MESSENGER,
        channelValue = "messenger",
        visitorId = null,
        name = name,
        email = email,
        assigneeId = null,
        waitingSince = if (waiting) Instant.parse("2026-11-27T08:00:00Z") else null,
        lastMessageAt = lastMessageAt,
        updatedAt = updatedAt,
        lastMessagePreview = preview,
    )

    private fun message(id: String, at: String?) = Message(
        id = id,
        createdAt = at?.let(Instant::parse),
        conversationId = "dconv_1",
        kind = MessageKind.MESSAGE,
        body = id,
        authorType = AuthorType.VISITOR,
        authorId = null,
        attachments = emptyList(),
        eventType = null,
        rating = null,
    )

    @Test
    fun theInboxFiltersBecomeTheQuery() {
        val mine = DeskLogic.inboxRequest(InboxQuery(assignee = AssigneeFilter.MINE, sort = InboxSort.OLDEST, search = "  #42 "), "user_1")
        assertEquals(InboxRequest("open", "user_1", null, "#42", "oldest"), mine)
        val unassigned = DeskLogic.inboxRequest(InboxQuery(state = ConversationState.CLOSED, assignee = AssigneeFilter.UNASSIGNED), "user_1")
        assertEquals(InboxRequest("closed", null, true, null, "newest"), unassigned)
        assertNull(DeskLogic.inboxRequest(InboxQuery(assignee = AssigneeFilter.MINE), null).assigneeId)
    }

    @Test
    fun theSortChipStepsThroughEveryOrder() {
        assertEquals(InboxSort.WAITING_LONGEST, InboxSort.NEWEST.next())
        assertEquals(InboxSort.OLDEST, InboxSort.WAITING_LONGEST.next())
        assertEquals(InboxSort.NEWEST, InboxSort.OLDEST.next())
    }

    @Test
    fun aRowShowsTheCustomerAndTheLastMessage() {
        assertEquals("Ann", DeskLogic.rowTitle(conversation(name = "Ann", email = "ann@example.test")))
        assertEquals("ann@example.test", DeskLogic.rowTitle(conversation(name = " ", email = "ann@example.test")))
        assertNull(DeskLogic.rowTitle(conversation()))
        assertEquals("Hello", DeskLogic.rowSubtitle(conversation(preview = "Hello", title = "Order")))
        assertEquals("Order", DeskLogic.rowSubtitle(conversation(title = "Order", email = "a@b.test")))
        assertEquals("a@b.test", DeskLogic.rowSubtitle(conversation(email = "a@b.test")))
        assertEquals("", DeskLogic.rowSubtitle(conversation()))
        assertEquals("Order", DeskLogic.rowSubject(conversation(title = "Order")))
        assertEquals("#42", DeskLogic.rowSubject(conversation()))
        assertTrue(conversation(waiting = true).isWaiting)
    }

    @Test
    fun theThreadIsTitledLikeThePlatformsHeaderWithoutSayingAnythingTwice() {
        // The subject first, then the customer, as the platform's header.
        assertEquals("Order", DeskLogic.threadTitle(conversation(title = "Order", name = "Ann", email = "ann@example.test")))
        assertEquals("Ann · #42", DeskLogic.threadSubtitle(conversation(title = "Order", name = "Ann", email = "ann@example.test")))
        // No subject: the email is the title, and isn't repeated under it.
        assertEquals("gert@example.test", DeskLogic.threadTitle(conversation(email = "gert@example.test")))
        assertEquals("#42", DeskLogic.threadSubtitle(conversation(email = "gert@example.test")))
        assertNull(DeskLogic.threadTitle(conversation()))
        assertEquals("#42", DeskLogic.threadSubtitle(conversation()))
    }

    @Test
    fun theInboxIsGroupedByDayAsOnThePlatform() {
        // Friday 27 November 2026; the week starts on Monday the 23rd.
        val today = LocalDate.of(2026, 11, 27)
        assertEquals(DeskLogic.DateGroup.Today, DeskLogic.dateGroup(today, today))
        assertEquals(DeskLogic.DateGroup.Yesterday, DeskLogic.dateGroup(today.minusDays(1), today))
        assertEquals(DeskLogic.DateGroup.Weekday(DayOfWeek.MONDAY), DeskLogic.dateGroup(LocalDate.of(2026, 11, 23), today))
        assertEquals(DeskLogic.DateGroup.LastWeek, DeskLogic.dateGroup(LocalDate.of(2026, 11, 22), today))
        assertEquals(DeskLogic.DateGroup.LastWeek, DeskLogic.dateGroup(LocalDate.of(2026, 11, 16), today))
        assertEquals(DeskLogic.DateGroup.WeeksAgo(2), DeskLogic.dateGroup(LocalDate.of(2026, 11, 15), today))
        assertEquals(DeskLogic.DateGroup.WeeksAgo(3), DeskLogic.dateGroup(LocalDate.of(2026, 11, 2), today))
        assertEquals(DeskLogic.DateGroup.Month(YearMonth.of(2026, 10), withYear = false), DeskLogic.dateGroup(LocalDate.of(2026, 10, 30), today))
        assertEquals(DeskLogic.DateGroup.Month(YearMonth.of(2025, 12), withYear = true), DeskLogic.dateGroup(LocalDate.of(2025, 12, 31), today))
        assertEquals(DeskLogic.DateGroup.Later(today.plusDays(2)), DeskLogic.dateGroup(today.plusDays(2), today))

        val now = Instant.parse("2026-11-27T12:00:00Z")
        val first = conversation(lastMessageAt = Instant.parse("2026-11-27T10:00:00Z")).copy(id = "a")
        val second = conversation(lastMessageAt = Instant.parse("2026-11-20T10:00:00Z")).copy(id = "b")
        val third = conversation(lastMessageAt = Instant.parse("2026-11-27T09:00:00Z")).copy(id = "c")
        val groups = DeskLogic.groupByDate(listOf(first, second, third), now, ZoneOffset.UTC)
        assertEquals(listOf(DeskLogic.DateGroup.Today, DeskLogic.DateGroup.LastWeek), groups.map { it.first })
        assertEquals(listOf("a", "c"), groups[0].second.map { it.id })
    }

    @Test
    fun theSlaChipCountsDownAndTurnsRedWhenOverdue() {
        val now = Instant.parse("2026-11-27T12:00:00Z")
        fun sla(status: String?, due: Instant?, metric: String? = "first_response", state: ConversationState = ConversationState.OPEN) =
            conversation().copy(slaStatus = status, slaDueAt = due, slaMetric = metric, state = state)

        assertNull(DeskLogic.slaDisplay(sla(null, now.plusSeconds(600)), now))
        assertEquals(
            DeskLogic.SlaDisplay(DeskLogic.SlaLabel.DueIn("first_response", "10m"), DeskLogic.SlaTone.OK),
            DeskLogic.slaDisplay(sla("active", now.plusSeconds(600)), now),
        )
        assertEquals(DeskLogic.SlaTone.WARNING, DeskLogic.slaDisplay(sla("warning", now.plusSeconds(600)), now)?.tone)
        assertEquals(
            DeskLogic.SlaDisplay(DeskLogic.SlaLabel.Overdue("first_response", "2h 5m"), DeskLogic.SlaTone.BREACHED),
            DeskLogic.slaDisplay(sla("active", now.minusSeconds(7_500)), now),
        )
        // Closed, or no running target: only a breach shows in the list.
        assertEquals(DeskLogic.SlaLabel.Breached, DeskLogic.slaDisplay(sla("breached", now, state = ConversationState.CLOSED), now)?.label)
        assertNull(DeskLogic.slaDisplay(sla("paused", null), now))
        assertEquals(DeskLogic.SlaLabel.Paused, DeskLogic.slaDisplay(sla("paused", null), now, showPaused = true)?.label)
        assertEquals(DeskLogic.SlaLabel.Achieved, DeskLogic.slaDisplay(sla("achieved", null), now, showFinished = true)?.label)

        assertEquals("1m", DeskLogic.formatSlaDuration(10_000))
        assertEquals("45m", DeskLogic.formatSlaDuration(45 * 60_000L))
        assertEquals("3h", DeskLogic.formatSlaDuration(3 * 3_600_000L))
        assertEquals("2d 4h", DeskLogic.formatSlaDuration((52 * 60) * 60_000L))
        assertEquals("2d", DeskLogic.formatSlaDuration((48 * 60) * 60_000L))
    }

    @Test
    fun aRowsBadgesFollowThePlatformsOrder() {
        val now = Instant.parse("2026-11-27T12:00:00Z")
        val row = conversation(waiting = true).copy(
            priority = "high",
            tags = listOf("vip", "billing", "third"),
            channel = DeskChannel.EMAIL,
            slaStatus = "active",
            slaDueAt = now.plusSeconds(3_600),
            slaMetric = "resolution",
        )
        assertEquals(
            listOf(
                DeskLogic.RowBadge.Sla(DeskLogic.SlaDisplay(DeskLogic.SlaLabel.DueIn("resolution", "1h"), DeskLogic.SlaTone.OK)),
                DeskLogic.RowBadge.Priority("high"),
                DeskLogic.RowBadge.Tag("vip"),
                DeskLogic.RowBadge.Tag("billing"),
                DeskLogic.RowBadge.Channel(DeskChannel.EMAIL),
                DeskLogic.RowBadge.Unassigned,
                DeskLogic.RowBadge.Waiting,
            ),
            DeskLogic.rowBadges(row, now),
        )
        // Chat has no channel badge, medium no priority badge, an assignee no "Unassigned".
        val quiet = conversation().copy(priority = "medium", assigneeId = "user_1")
        assertEquals(emptyList<DeskLogic.RowBadge>(), DeskLogic.rowBadges(quiet, now))
    }

    @Test
    fun theTimelineSaysHowLongAgoAndWhereADayStarts() {
        val now = Instant.parse("2026-11-27T12:00:00Z")
        assertEquals(DeskLogic.Ago.Now, DeskLogic.ago(now.minusSeconds(30), now, ZoneOffset.UTC))
        assertEquals(DeskLogic.Ago.Minutes(4), DeskLogic.ago(now.minusSeconds(240), now, ZoneOffset.UTC))
        assertEquals(DeskLogic.Ago.Hours(2), DeskLogic.ago(now.minusSeconds(7_300), now, ZoneOffset.UTC))
        assertEquals(DeskLogic.Ago.Days(3), DeskLogic.ago(now.minusSeconds(3 * 86_400L), now, ZoneOffset.UTC))
        assertEquals(DeskLogic.Ago.On(LocalDate.of(2026, 11, 1)), DeskLogic.ago(Instant.parse("2026-11-01T08:00:00Z"), now, ZoneOffset.UTC))

        val first = message("a", "2026-11-26T09:00:00Z")
        val second = message("b", "2026-11-26T18:00:00Z")
        val third = message("c", "2026-11-27T08:00:00Z")
        assertTrue(DeskLogic.startsDay(null, first, ZoneOffset.UTC))
        assertFalse(DeskLogic.startsDay(first, second, ZoneOffset.UTC))
        assertTrue(DeskLogic.startsDay(second, third, ZoneOffset.UTC))
    }

    @Test
    fun aTagChangeSaysWhatWasAddedAndRemoved() {
        val change = AttributeChange("tags", from = ChangeValue.Items(listOf("a", "b")), to = ChangeValue.Items(listOf("b", "c")))
        assertEquals(listOf("c") to listOf("a"), DeskLogic.tagDiff(change))
        assertTrue(DeskLogic.isCleared(ChangeValue.Empty))
        assertTrue(DeskLogic.isCleared(ChangeValue.Items(emptyList())))
        assertFalse(DeskLogic.isCleared(ChangeValue.Text("high")))
        assertFalse(DeskLogic.isCleared(ChangeValue.Flag(false)))
    }

    @Test
    fun aRowsTimeIsTheLastMessageElseTheLastChange() {
        val last = Instant.parse("2026-11-27T10:00:00Z")
        assertEquals(last, DeskLogic.rowTime(conversation(lastMessageAt = last)))
        assertEquals(Instant.parse("2026-11-27T09:00:00Z"), DeskLogic.rowTime(conversation()))
    }

    @Test
    fun aMessageIsReplacedByIdOrAddedInTimeOrder() {
        val first = message("a", "2026-11-27T09:00:00Z")
        val third = message("c", "2026-11-27T11:00:00Z")
        val second = message("b", "2026-11-27T10:00:00Z")
        val merged = DeskLogic.mergeMessage(listOf(first, third), second)
        assertEquals(listOf("a", "b", "c"), merged.map { it.id })
        val edited = second.copy(body = "edited")
        assertEquals("edited", DeskLogic.mergeMessage(merged, edited)[1].body)
        assertEquals(3, DeskLogic.mergeMessage(merged, edited).size)
    }

    @Test
    fun theAssigneeIsYouATeammateOrNobody() {
        val members = listOf(Member("user_2", "Bob", "bob@example.test", null))
        assertEquals(DeskLogic.AssigneeLabel.Unassigned, DeskLogic.assigneeLabel(null, "user_1", members))
        assertEquals(DeskLogic.AssigneeLabel.You, DeskLogic.assigneeLabel("user_1", "user_1", null))
        assertEquals(DeskLogic.AssigneeLabel.Teammate("Bob"), DeskLogic.assigneeLabel("user_2", "user_1", members))
        assertEquals(DeskLogic.AssigneeLabel.Someone, DeskLogic.assigneeLabel("user_3", "user_1", members))
        assertEquals(DeskLogic.AssigneeLabel.Someone, DeskLogic.assigneeLabel("user_2", "user_1", null))
    }

    @Test
    fun theRosterIsNamedAndSearchable() {
        assertEquals(Member("u1", "Ann", "ann@x.test", null), DeskLogic.member("u1", "Ann", "ann@x.test", " "))
        assertEquals("ann@x.test", DeskLogic.member("u1", " ", "ann@x.test", null)?.name)
        assertEquals("u1", DeskLogic.member("u1", null, null, null)?.name)
        assertNull(DeskLogic.member("", "Ann", null, null))
        val members = listOf(Member("u1", "Ann Agent", "ann@x.test", null), Member("u2", "Bob", "bob@y.test", null))
        assertEquals(listOf("u1"), DeskLogic.filterMembers(members, " ANN ").map { it.userId })
        assertEquals(listOf("u2"), DeskLogic.filterMembers(members, "y.test").map { it.userId })
        assertEquals(2, DeskLogic.filterMembers(members, "").size)
    }

    @Test
    fun fileSizesReadLikeTheExpoApp() {
        assertEquals("", DeskLogic.formatFileSize(null))
        assertEquals("", DeskLogic.formatFileSize(0))
        assertEquals("512 B", DeskLogic.formatFileSize(512))
        assertEquals("1 KB", DeskLogic.formatFileSize(1024))
        assertEquals("1.5 KB", DeskLogic.formatFileSize(1536))
        assertEquals("1.4 MB", DeskLogic.formatFileSize(1_468_006))
        assertEquals("12 MB", DeskLogic.formatFileSize(12L * 1024 * 1024))
    }

    @Test
    fun onlyWebLinksOpenAndImagesShowAsThumbnails() {
        assertTrue(DeskLogic.isOpenableUrl(" https://files.example.test/a.png"))
        assertTrue(DeskLogic.isOpenableUrl("HTTP://x.test"))
        assertFalse(DeskLogic.isOpenableUrl("javascript:alert(1)"))
        assertFalse(DeskLogic.isOpenableUrl("file:///etc/passwd"))
        assertFalse(DeskLogic.isOpenableUrl(null))
        assertTrue(DeskLogic.isImage("IMAGE/PNG"))
        assertFalse(DeskLogic.isImage("application/pdf"))
        assertFalse(DeskLogic.isImage(null))
    }

    @Test
    fun aReplysFilesFollowTheServersRules() {
        assertNull(DeskLogic.attachmentProblem("image/jpeg", 1000))
        assertNull(DeskLogic.attachmentProblem("application/pdf", null))
        assertEquals(DeskLogic.AttachmentProblem.TOO_LARGE, DeskLogic.attachmentProblem("image/jpeg", DeskLogic.MAX_ATTACHMENT_BYTES + 1))
        assertEquals(DeskLogic.AttachmentProblem.TYPE_NOT_ALLOWED, DeskLogic.attachmentProblem("video/mp4", 10))
        assertEquals(DeskLogic.AttachmentProblem.TYPE_NOT_ALLOWED, DeskLogic.attachmentProblem(null, 10))
        assertEquals("photo.jpg", DeskLogic.displayName("  ", "photo.jpg"))
        assertEquals("a.pdf", DeskLogic.displayName(" a.pdf ", "x"))
    }

    @Test
    fun aNotificationOpensItsConversation() {
        assertEquals("dconv_1", DeskLogic.conversationIdFromPush(mapOf("conversationId" to "dconv_1")))
        assertEquals("dconv_2", DeskLogic.conversationIdFromPush(mapOf("entityType" to "desk_conversation", "entityId" to "dconv_2")))
        assertEquals("dconv_3", DeskLogic.conversationIdFromPush(mapOf("actionUrl" to "/welddesk/inbox/dconv_3")))
        assertEquals("dconv_4", DeskLogic.conversationIdFromPush(mapOf("actionUrl" to "https://app.weldsuite.eu/welddesk/inbox/dconv_4/?x=1")))
        assertNull(DeskLogic.conversationIdFromPush(mapOf("entityType" to "ticket", "entityId" to "tkt_1", "ticketId" to "tkt_1")))
        assertNull(DeskLogic.conversationIdFromPush(mapOf("actionUrl" to "/welddesk/tickets/tkt_1")))
        assertEquals(DeskRoute.Conversation("dconv_1"), DeskLogic.routeForPush(mapOf("conversationId" to "dconv_1")))
        assertEquals(DeskRoute.Inbox, DeskLogic.routeForPush(mapOf("ticketId" to "tkt_1")))
    }

    @Test
    fun theExpoAppsLinksOpenTheSameScreens() {
        assertEquals(DeskRoute.Conversation("dconv_1"), DeskLogic.routeForLink("welddesk://conversation/dconv_1"))
        assertEquals(DeskRoute.Settings, DeskLogic.routeForLink("welddesk://settings"))
        assertEquals(DeskRoute.Inbox, DeskLogic.routeForLink("welddesk://"))
        assertEquals(DeskRoute.Inbox, DeskLogic.routeForLink("welddesk://inbox"))
        assertNull(DeskLogic.routeForLink("welddesk://sso-callback?code=x"))
        assertNull(DeskLogic.routeForLink("https://example.test/conversation/1"))
        assertNull(DeskLogic.routeForLink("welddesk://conversation"))
    }

    @Test
    fun theRoomTracksVisitorsTypingAndOnline() {
        var state = RoomState.reduce(RoomState(), "connected", RoomFields(presence = listOf("user_1", "visitor:v1")))
        assertTrue(state.visitorOnline)
        state = RoomState.reduce(state, "typing", RoomFields(userId = "visitor:v1", userName = "Ann", isTyping = true))
        state = RoomState.reduce(state, "typing", RoomFields(userId = "user_2", userName = "Bob", isTyping = true))
        assertEquals(listOf("Ann"), state.visitorsTyping)
        state = RoomState.reduce(state, "typing", RoomFields(userId = "visitor:v1", isTyping = false))
        assertEquals(emptyList<String>(), state.visitorsTyping)
        state = RoomState.reduce(state, "presence:leave", RoomFields(userId = "visitor:v1"))
        assertFalse(state.visitorOnline)
        state = RoomState.reduce(state, "presence:join", RoomFields(userId = "visitor:v2"))
        assertTrue(state.visitorOnline)
        assertEquals(state, RoomState.reduce(state, "message", RoomFields(userId = "visitor:v2")))
        val typing = RoomState.reduce(state, "typing", RoomFields(userId = "visitor:v2", userName = "Cy", isTyping = true))
        assertEquals(emptyList<String>(), typing.withoutTyping("visitor:v2").visitorsTyping)
    }

    @Test
    fun typingIsSentAtMostEveryThreeSecondsAndStoppedOnce() {
        val throttle = TypingThrottle()
        assertFalse(throttle.stop())
        assertTrue(throttle.keystroke(10_000))
        assertFalse(throttle.keystroke(11_000))
        assertFalse(throttle.keystroke(13_000))
        assertTrue(throttle.keystroke(13_001))
        assertTrue(throttle.stop())
        assertFalse(throttle.stop())
        assertTrue(throttle.keystroke(13_500))
    }

    @Test
    fun serverValuesAreReadLeniently() {
        assertEquals(ConversationState.CLOSED, ConversationState.of("closed"))
        assertEquals(ConversationState.OPEN, ConversationState.of("pending"))
        assertEquals(DeskChannel.EMAIL, DeskChannel.of("email"))
        assertEquals(DeskChannel.OTHER, DeskChannel.of("telegram"))
        assertEquals(DeskChannel.OTHER, DeskChannel.of(""))
        assertEquals(MessageKind.EVENT, MessageKind.of("event"))
        assertEquals(AuthorType.BOT, AuthorType.of("bot"))
        assertEquals(AuthorType.SYSTEM, AuthorType.of("workflow"))
    }
}
