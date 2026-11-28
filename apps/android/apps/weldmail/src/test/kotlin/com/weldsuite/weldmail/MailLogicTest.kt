package com.weldsuite.weldmail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

class MailLogicTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val now: Instant = Instant.parse("2026-11-27T10:00:00Z")

    private fun message(
        id: String,
        sent: String = "2026-11-27T09:00:00.000Z",
        thread: String? = null,
        read: Boolean = false,
        starred: Boolean = false,
        attachments: Boolean = false,
        labels: List<String> = emptyList(),
        from: MailAddress? = MailAddress("grace@example.com", "Grace"),
        to: List<MailAddress> = emptyList(),
        cc: List<MailAddress> = emptyList(),
    ) = MailMessage(
        id = id,
        accountId = "mail_1",
        smtpMessageId = "<$id@example.com>",
        threadId = thread,
        from = from,
        to = to,
        cc = cc,
        subject = "Invoice",
        sentDate = sent,
        createdAt = sent,
        isRead = read,
        isStarred = starred,
        hasAttachments = attachments,
        labels = labels,
    )

    @Test
    fun labelRowsFoldIntoFolderCountsAndCustomLabels() {
        val state = MailLogic.processLabels(
            listOf(
                LabelRow("l1", "Inbox", "INBOX", null, isSystem = true, count = 3),
                LabelRow("l2", "Inbox", "inbox", null, isSystem = true, count = 2),
                LabelRow("l3", "Clients", "clients", "#3B82F6", isSystem = false, count = 1),
                LabelRow("l4", "clients", "clients-2", null, isSystem = false, count = 4),
                LabelRow("l5", "Muted", "MUTED", null, isSystem = true, count = 9),
            ),
        )
        assertEquals(5, state.systemCounts["INBOX"])
        assertEquals(1, state.custom.size)
        assertEquals(5, state.custom.single().count)
        assertEquals("#3B82F6", state.custom.single().color)
    }

    @Test
    fun onlyTheMailboxsOwnLabelsShowOnARow() {
        assertEquals(listOf("Clients"), MailLogic.displayLabels(listOf("INBOX", "Clients", "STARRED")))
    }

    @Test
    fun aLabelsOwnColourIsReadFromItsHex() {
        assertEquals(0x3B82F6, MailLogic.parseHex("#3B82F6"))
        assertNull(MailLogic.parseHex("not a colour"))
        assertNull(MailLogic.parseHex(null))
    }

    @Test
    fun messagesGroupAsThePlatformsListWithPinnedFirst() {
        // Friday 27 November 2026; the week started on Monday the 23rd.
        val list = listOf(
            message("a", sent = "2026-11-27T08:00:00Z"),
            message("b", sent = "2026-11-26T23:30:00Z"),
            message("c", sent = "2026-11-23T10:00:00Z"),
            message("d", sent = "2026-11-18T10:00:00Z"),
            message("f", sent = "2026-11-05T10:00:00Z"),
            message("g", sent = "2026-10-01T10:00:00Z"),
            message("h", sent = "2025-12-24T10:00:00Z"),
            message("e", sent = "2026-10-02T10:00:00Z", labels = listOf("INBOX", "PINNED")),
        )
        val sections = MailLogic.sections(list, now = now, zone = zone)
        assertEquals(
            listOf(
                DateGroup(DateGroup.Kind.PINNED),
                DateGroup(DateGroup.Kind.TODAY),
                DateGroup(DateGroup.Kind.YESTERDAY),
                DateGroup(DateGroup.Kind.WEEKDAY, LocalDate.of(2026, 11, 23)),
                DateGroup(DateGroup.Kind.LAST_WEEK),
                DateGroup(DateGroup.Kind.WEEKS_AGO, weeks = 3),
                DateGroup(DateGroup.Kind.MONTH, LocalDate.of(2026, 10, 1)),
                DateGroup(DateGroup.Kind.MONTH_YEAR, LocalDate.of(2025, 12, 1)),
            ),
            sections.map { it.group },
        )
        assertEquals(listOf("e"), sections.first().messages.map { it.id })
    }

    @Test
    fun aScheduledSendGetsItsOwnDayAndRowsReadTheirDateAsThePlatform() {
        assertEquals(
            DateGroup(DateGroup.Kind.UPCOMING, LocalDate.of(2026, 12, 3)),
            MailLogic.dateGroup("2026-12-03T09:00:00Z", now, zone),
        )
        assertEquals(DateGroup(DateGroup.Kind.TODAY), MailLogic.dateGroup("2026-11-27T18:00:00Z", now, zone))
        assertEquals(DateStyle.TIME, MailLogic.dateStyle(Instant.parse("2026-11-27T01:00:00Z"), now, zone))
        assertEquals(DateStyle.DAY, MailLogic.dateStyle(Instant.parse("2026-01-02T01:00:00Z"), now, zone))
        assertEquals(DateStyle.DAY_YEAR, MailLogic.dateStyle(Instant.parse("2025-12-31T01:00:00Z"), now, zone))
    }

    @Test
    fun ownMailNamesItsRecipientsAndTheConversationEndsWithTheNewest() {
        assertTrue(MailLogic.isOutgoingFolder("sent"))
        assertFalse(MailLogic.isOutgoingFolder("INBOX"))
        assertEquals("Jane Doe, bob@example.com", MailLogic.recipientNames(listOf(MailAddress("jane@example.com", "Jane Doe"), MailAddress("bob@example.com"))))
        assertNull(MailLogic.recipientNames(emptyList()))
        val sent = message("m", to = listOf(MailAddress("me@weld.test")), cc = listOf(MailAddress("sanne.bakker@example.com")))
        assertEquals(listOf("me", "Sanne Bakker"), MailLogic.recipientsLine(sent, listOf("ME@weld.test"), "me"))
        val older = message("x", sent = "2026-11-26T09:00:00Z")
        val newer = message("y", sent = "2026-11-27T09:00:00Z")
        assertEquals(listOf("x", "y"), MailLogic.conversation(older, listOf(newer, older)).map { it.id })
        assertTrue(MailLogic.isImportant(message("i", labels = listOf("IMPORTANT"))))
    }

    @Test
    fun aPinIsTheServersPinnedLabel() {
        assertTrue(MailLogic.isPinned(message("p", labels = listOf("pinned"))))
        assertFalse(MailLogic.isPinned(message("q", labels = listOf("INBOX"))))
        assertEquals(listOf("INBOX", "PINNED"), MailLogic.withPinned(listOf("INBOX"), on = true))
        assertEquals(listOf("INBOX", "PINNED"), MailLogic.withPinned(listOf("INBOX", "PINNED"), on = true))
        assertEquals(listOf("INBOX"), MailLogic.withPinned(listOf("INBOX", "PINNED"), on = false))
        // The pin is a system label: never a chip on the row.
        assertEquals(emptyList<String>(), MailLogic.displayLabels(listOf("PINNED")))
    }

    @Test
    fun theQuickFiltersPickTheirMessages() {
        val list = listOf(
            message("a", read = true),
            message("b"),
            message("c", read = true, labels = listOf("STARRED")),
            message("d", read = true, attachments = true),
        )
        assertEquals(listOf("b"), MailLogic.filter(list, InboxFilter.UNREAD).map { it.id })
        assertEquals(listOf("c"), MailLogic.filter(list, InboxFilter.STARRED).map { it.id })
        assertEquals(listOf("d"), MailLogic.filter(list, InboxFilter.ATTACHMENTS).map { it.id })
    }

    @Test
    fun threadCountsCountTheLoadedMessagesOfAThread() {
        val counted = MailLogic.withThreadCounts(listOf(message("a", thread = "t"), message("b", thread = "t"), message("c")))
        assertEquals(listOf(2, 2, 1), counted.map { it.threadCount })
    }

    @Test
    fun aRefreshKeepsThePagesAlreadyScrolledTo() {
        val first = listOf(message("n1", sent = "2026-11-27T09:00:00Z"), message("n2", sent = "2026-11-27T08:00:00Z"))
        val older = listOf(message("o1", sent = "2026-11-20T08:00:00Z"))
        val (list, cursor) = MailLogic.mergeFirstPage(first + older, first, "n2", "o1", previousKnown = true)
        assertEquals(listOf("n1", "n2", "o1"), list.map { it.id })
        assertEquals("o1", cursor)
        // A list from the offline cache has no known place: the page replaces it.
        val (fresh, freshCursor) = MailLogic.mergeFirstPage(older, first, "n2", null, previousKnown = false)
        assertEquals(listOf("n1", "n2"), fresh.map { it.id })
        assertEquals("n2", freshCursor)
    }

    @Test
    fun aPageAppendsWithoutRepeats() {
        val list = MailLogic.appendPage(listOf(message("a"), message("b")), listOf(message("b"), message("c")))
        assertEquals(listOf("a", "b", "c"), list.map { it.id })
    }

    @Test
    fun theNextMessageFollowsTheListOrder() {
        assertEquals("b", MailLogic.nextId(listOf("a", "b", "c"), "a"))
        assertNull(MailLogic.nextId(listOf("a", "b"), "b"))
        assertNull(MailLogic.nextId(listOf("a"), "x"))
    }

    @Test
    fun addressesSplitOnCommasAndSemicolons() {
        assertEquals(listOf("a@b.com", "c@d.com", "e@f.com"), MailLogic.splitAddresses(" a@b.com, c@d.com;e@f.com "))
        assertEquals("bob@x.com", MailLogic.committedAddress("bob@x.com,"))
        assertNull(MailLogic.committedAddress("bob@x.com"))
        assertEquals(listOf("a@b.com", "typed@x.com"), MailLogic.withPending(listOf("a@b.com"), "typed@x.com"))
    }

    @Test
    fun aReplyGoesToTheSenderAndThreads() {
        val original = message(
            "m1",
            from = MailAddress("grace@example.com", "Grace"),
            to = listOf(MailAddress("me@acme.com"), MailAddress("bob@example.com")),
            cc = listOf(MailAddress("carol@example.com"), MailAddress("ME@acme.com")),
        ).copy(subject = "Invoice", references = listOf("<older@x>"))
        val reply = MailLogic.prefill(original, ComposeMode.REPLY, listOf("me@acme.com"), "Unknown")
        assertEquals(listOf("grace@example.com"), reply.to)
        assertEquals("Re: Invoice", reply.subject)
        assertEquals("<m1@example.com>", reply.inReplyTo)
        assertEquals(listOf("<older@x>", "<m1@example.com>"), reply.references)

        val all = MailLogic.prefill(original, ComposeMode.REPLY_ALL, listOf("me@acme.com"), "Unknown")
        assertEquals(listOf("grace@example.com", "bob@example.com"), all.to)
        assertEquals(listOf("carol@example.com"), all.cc)

        val forward = MailLogic.prefill(original.copy(subject = "Fwd: Invoice"), ComposeMode.FORWARD, emptyList(), "Unknown")
        assertTrue(forward.to.isEmpty())
        assertEquals("Fwd: Invoice", forward.subject)
        assertNull(forward.inReplyTo)
    }

    @Test
    fun aReplyToOnesOwnMailGoesToItsRecipients() {
        val sent = message("m2", from = MailAddress("me@acme.com"), to = listOf(MailAddress("bob@example.com")))
        assertEquals(listOf("bob@example.com"), MailLogic.prefill(sent, ComposeMode.REPLY, listOf("me@acme.com"), "Unknown").to)
    }

    @Test
    fun aNameWithACommaIsNeverTwoRecipients() {
        assertEquals(listOf("jane@x.com"), MailLogic.addresses(listOf(MailAddress("\"Doe, Jane\" <jane@x.com>"))))
    }

    @Test
    fun htmlBodiesCarryTheQuoteAsHtml() {
        val prefill = ComposePrefill(mode = ComposeMode.REPLY, quotedBody = "Bob <bob@x.com>\nhi")
        val suffix = MailLogic.quotedSuffix(prefill, "Original message", "From: x", "Subject: y")
        val payload = MailLogic.sendPayload(
            listOf("a@b.com"), emptyList(), emptyList(), " ", "Hi", "<p>Hi</p>", suffix, emptyList(), "snd_1",
            "<m1@x>", listOf("<m1@x>"), "(No subject)",
        )
        assertEquals("(No subject)", payload.subject)
        assertNull(payload.body)
        assertTrue(payload.htmlBody!!.contains("Bob &lt;bob@x.com&gt;<br>hi"))
        assertNull(payload.cc)
        assertEquals(listOf("<m1@x>"), payload.references)

        val plain = MailLogic.sendPayload(listOf("a@b.com"), emptyList(), emptyList(), "S", "Hi", "", "", emptyList(), null, null, emptyList(), "(No subject)")
        assertEquals("Hi", plain.body)
        assertNull(plain.htmlBody)
        assertNull(plain.references)
    }

    @Test
    fun aMailWithNothingToReadAsksFirst() {
        assertTrue(MailLogic.hasNoBody("  ", "", 0))
        assertFalse(MailLogic.hasNoBody("", "", 1))
        assertFalse(MailLogic.hasNoBody("", "quote", 0))
    }

    @Test
    fun sendLaterChoicesStayInTheScheduleWindow() {
        val evening = ZonedDateTime.of(LocalDate.of(2026, 11, 27), LocalTime.of(22, 30), zone)
        val presets = MailLogic.sendLaterPresets(evening)
        assertEquals(4, presets.size)
        assertEquals(LocalTime.of(9, 0), presets[2].second.toLocalTime())
        assertTrue(MailLogic.isWithinScheduleWindow(now.plusSeconds(60), now))
        assertFalse(MailLogic.isWithinScheduleWindow(now.minusSeconds(60), now))
        assertFalse(MailLogic.isWithinScheduleWindow(now.plusSeconds(366L * 24 * 3600), now))
    }

    @Test
    fun snoozeChoicesAreAnHourFourHoursTomorrowAndMonday() {
        val friday = ZonedDateTime.of(LocalDate.of(2026, 11, 27), LocalTime.of(10, 0), zone)
        val presets = MailLogic.snoozePresets(friday).map { it.second }
        assertEquals(friday.plusHours(1), presets[0])
        assertEquals(friday.plusHours(4), presets[1])
        assertEquals(ZonedDateTime.of(LocalDate.of(2026, 11, 28), LocalTime.of(8, 0), zone), presets[2])
        assertEquals(ZonedDateTime.of(LocalDate.of(2026, 11, 30), LocalTime.of(8, 0), zone), presets[3])
    }

    @Test
    fun subscriptionsKnowHowTheyCanBeLeft() {
        val link = MailSubscription("s", "a", "news@x.com", lastReceivedAt = "2026-11-01T00:00:00Z", active = true, unsubscribeUrl = "https://x")
        assertTrue(MailLogic.canUnsubscribe(link))
        assertTrue(MailLogic.isLinkOnly(link))
        assertFalse(MailLogic.isLinkOnly(link.copy(oneClick = true)))
        assertEquals(link, MailLogic.subscriptionFor(listOf(link), " NEWS@x.com "))
        val after = link.copy(active = false, unsubscribedAt = "2026-10-01T00:00:00Z")
        assertTrue(MailLogic.stillSending(after))
        assertTrue(MailLogic.matchesSubscription(link, "NEWS"))
    }

    @Test
    fun pushIdsAreCheckedBeforeUse() {
        val target = MailLogic.notificationTarget(
            mapOf("emailId" to "msg_1", "emailAccountId" to "mail_2", "subject" to "Hello\u0000there", "fromName" to "Grace"),
        )!!
        assertEquals("msg_1", target.emailId)
        assertEquals("mail_2", target.accountId)
        assertEquals("Hello there", target.subject)
        assertNull(MailLogic.notificationTarget(mapOf("emailId" to "../../etc", "emailAccountId" to "a b")))
        assertEquals("msg_9", MailLogic.notificationTarget(mapOf("entityType" to "email", "entityId" to "msg_9"))?.emailId)
    }

    @Test
    fun attachmentsAreKnownByTheirExtension() {
        assertEquals(AttachmentKind.PDF, MailLogic.attachmentKind("invoice.PDF"))
        assertEquals(AttachmentKind.FILE, MailLogic.attachmentKind("README"))
        assertEquals("XLSX", MailLogic.extensionLabel("a.xlsx"))
        assertEquals("", MailLogic.extensionLabel("a.verylong"))
        assertEquals("2 KB", MailLogic.fileSize(2048))
        assertEquals("1.5 MB", MailLogic.fileSize(1_572_864))
        assertEquals("_etc_passwd", MailLogic.safeFileName("../etc/passwd").removePrefix("."))
        assertEquals("attachment", MailLogic.safeFileName("..."))
    }

    @Test
    fun anIdempotencyKeyFitsTheServersLimit() {
        val key = MailLogic.idempotencyKey(1_700_000_000_000) { 35 }
        assertEquals("snd_1700000000000_zzzzzzzz", key)
        assertTrue(key.length <= 64)
    }
}
