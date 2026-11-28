package com.weldsuite.weldmail

import com.weldsuite.weldmail.offline.FailureKind
import com.weldsuite.weldmail.offline.FlagPatch
import com.weldsuite.weldmail.offline.OutboxOp
import com.weldsuite.weldmail.offline.OutboxRules
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.ZoneOffset

class MailRulesTest {
    private fun message(id: String, sent: String = "2026-11-27T09:00:00Z", read: Boolean = false, attachments: Boolean = false, from: String = "grace@example.com", to: List<String> = emptyList()) =
        MailMessage(
            id = id,
            accountId = "mail_1",
            from = MailAddress(from),
            to = to.map { MailAddress(it) },
            sentDate = sent,
            createdAt = sent,
            isRead = read,
            hasAttachments = attachments,
        )

    // ---------------------------------------------------------------- search

    @Test
    fun searchFiltersApplyOnThePhone() {
        val now = Instant.parse("2026-11-27T12:00:00Z")
        val list = listOf(
            message("mine", from = "me@acme.com", to = listOf("bob@x.com")),
            message("theirs", to = listOf("me@acme.com"), sent = "2026-11-26T08:00:00Z"),
            message("old", sent = "2026-01-02T08:00:00Z", read = true, attachments = true),
        )
        val own = listOf("ME@acme.com")
        assertEquals(listOf("mine"), SearchLogic.apply(list, SearchFilters(fromMe = true), own, now, ZoneOffset.UTC).map { it.id })
        assertEquals(listOf("theirs"), SearchLogic.apply(list, SearchFilters(toMe = true), own, now, ZoneOffset.UTC).map { it.id })
        assertEquals(listOf("theirs"), SearchLogic.apply(list, SearchFilters(date = SearchLogic.DateRange.YESTERDAY), own, now, ZoneOffset.UTC).map { it.id })
        assertEquals(listOf("old"), SearchLogic.apply(list, SearchFilters(unread = false, attachment = true), own, now, ZoneOffset.UTC).map { it.id })
        assertEquals(3, SearchLogic.apply(list, SearchFilters(date = SearchLogic.DateRange.THIS_YEAR), own, now, ZoneOffset.UTC).size)
        assertFalse(SearchFilters().isActive)
        assertTrue(SearchFilters(label = "SENT").isActive)
    }

    @Test
    fun theWeekStartsOnMonday() {
        val friday = Instant.parse("2026-11-27T12:00:00Z")
        assertTrue(SearchLogic.inRange("2026-11-23T00:30:00Z", SearchLogic.DateRange.THIS_WEEK, friday, ZoneOffset.UTC))
        assertFalse(SearchLogic.inRange("2026-11-22T23:30:00Z", SearchLogic.DateRange.THIS_WEEK, friday, ZoneOffset.UTC))
        assertFalse(SearchLogic.inRange("not a date", SearchLogic.DateRange.TODAY, friday, ZoneOffset.UTC))
    }

    @Test
    fun matchesIgnoreCaseAndNeverOverlap() {
        assertEquals(listOf(0..2, 8..10), SearchLogic.matches("Invoice invoice", "INV"))
        assertEquals(2, SearchLogic.matches("aaaa", "aa").size)
        assertTrue(SearchLogic.matches("text", "  ").isEmpty())
    }

    // ---------------------------------------------------------------- contacts

    private fun person(id: String, email: String?, first: String? = null, last: String? = null) =
        Person(id, email, first, last, null, null, null, null, null, null, null)

    @Test
    fun onlyTheExactAddressIsTheSender() {
        val people = listOf(person("p1", "grace.h@example.com"), person("p2", "Grace@Example.com"))
        assertEquals("p2", ContactLogic.exactMatch(people, " grace@example.com ")?.id)
        assertNull(ContactLogic.exactMatch(people, "ada@example.com"))
        val placeholder = ContactLogic.placeholder("ada@example.com")
        assertEquals("ada", placeholder.firstName)
        assertEquals("ada@example.com", placeholder.id)
    }

    @Test
    fun aNameEditSplitsAtTheFirstSpace() {
        assertEquals(ContactLogic.Change(firstName = "Ada", lastName = "King Lovelace"), ContactLogic.change(ContactLogic.Field.NAME, "Ada King Lovelace"))
        assertEquals(ContactLogic.Change(firstName = "Ada", lastName = ""), ContactLogic.change(ContactLogic.Field.NAME, "Ada"))
        assertEquals(ContactLogic.Change(phone = "+31 6"), ContactLogic.change(ContactLogic.Field.PHONE, "+31 6"))
        assertEquals(ContactLogic.Change(), ContactLogic.change(ContactLogic.Field.ADDRESS, "x"))
    }

    @Test
    fun onlyDigitsGoIntoACallLink() {
        assertEquals("+31612345678", ContactLogic.dialable("+31 (6) 1234-5678;ext=9".substringBefore(';')))
        assertEquals("1234", ContactLogic.dialable("12,34#"))
        assertTrue(ContactLogic.isEmail(" ada@example.com "))
        assertFalse(ContactLogic.isEmail("ada@example"))
        assertEquals("Ada King", ContactLogic.displayName(person("p", null, "Ada", "King")))
        assertNull(ContactLogic.value(person("p", " "), ContactLogic.Field.EMAIL))
    }

    // ---------------------------------------------------------------- new mailboxes

    @Test
    fun anAddressKeepsOnlyWhatAMailboxNameMayHold() {
        assertEquals("ada.k-1_x", AddAccountLogic.cleanAddress("Ada.K-1_x @é!"))
        assertEquals(AddAccountLogic.Check.Available, AddAccountLogic.check(Availability(true, null)))
        assertEquals(AddAccountLogic.Check.Unavailable("reserved"), AddAccountLogic.check(Availability(false, "reserved")))
        assertEquals(AddAccountLogic.Check.Unavailable("taken"), AddAccountLogic.check(Availability(false, null)))
    }

    // ---------------------------------------------------------------- send errors

    @Test
    fun aSendingLimitSaysWhichAndWhen() {
        val now = Instant.parse("2026-11-27T10:00:00Z")
        val alert = SendErrors.describe(
            "SENDING_LIMITED",
            SendErrorDetails(limit = 500, window = "day", retryAfter = "2026-11-27T10:25:00Z", suggestWeldReach = true),
            now,
            java.util.Locale.ROOT,
        )!!
        assertEquals(Text.Res(R.string.weldmail_send_error_daily_title), alert.title)
        assertEquals(4, alert.lines.size)
        assertEquals(Text.Res(R.string.weldmail_send_error_limit_per_day, listOf("500")), alert.lines[1])
        assertEquals(
            Text.Res(R.string.weldmail_send_error_retry_when, listOf(Text.Plural(R.plurals.weldmail_send_error_when_minutes, 25))),
            alert.lines[2],
        )
        assertNull(SendErrors.describe(null, SendErrorDetails(), now))
        assertNull(SendErrors.describe("SOMETHING_NEW", SendErrorDetails(), now))
        assertNull(SendErrors.describe("PARTIALLY_SENT", SendErrorDetails(), now))
    }

    @Test
    fun retryTimesRoundUp() {
        val now = Instant.parse("2026-11-27T10:00:00Z")
        assertEquals(Text.Res(R.string.weldmail_send_error_when_moment), SendErrors.whenText("2026-11-27T09:00:00Z", now))
        assertEquals(Text.Plural(R.plurals.weldmail_send_error_when_hours, 2), SendErrors.whenText("2026-11-27T11:30:00Z", now))
        assertEquals(Text.Res(R.string.weldmail_send_error_when_tomorrow), SendErrors.whenText("2026-11-28T10:00:00Z", now))
        assertEquals(Text.Plural(R.plurals.weldmail_send_error_when_days, 3), SendErrors.whenText("2026-11-30T09:00:00Z", now))
        assertNull(SendErrors.whenText("soon", now))
    }

    @Test
    fun aLongRecipientListIsShortened() {
        val alert = SendErrors.describe("RECIPIENT_SUPPRESSED", SendErrorDetails(recipients = listOf("a", "b", "c", "d", "e")), Instant.EPOCH)!!
        val line = alert.lines.first() as Text.Res
        assertEquals(R.string.weldmail_send_error_suppressed_list, line.id)
        assertEquals(
            Text.Joined(listOf(Text.Raw("a, b, c"), Text.Plural(R.plurals.weldmail_common_and_more, 2))),
            line.args.single(),
        )
    }

    // ---------------------------------------------------------------- the outbox

    private fun update(id: String, message: String, patch: FlagPatch) = OutboxOp.Update(id, message, patch, createdAt = 0)

    @Test
    fun flagChangesMergeAndADeleteWins() {
        var ops = OutboxRules.collapse(emptyList(), update("1", "m", FlagPatch(isRead = true)))
        ops = OutboxRules.collapse(ops, update("2", "m", FlagPatch(isStarred = true)))
        assertEquals(1, ops.size)
        assertEquals(FlagPatch(isRead = true, isStarred = true), (ops.single() as OutboxOp.Update).patch)
        ops = OutboxRules.collapse(ops, OutboxOp.Archive("3", "m", createdAt = 0))
        ops = OutboxRules.collapse(ops, OutboxOp.Archive("4", "m", createdAt = 0))
        assertEquals(2, ops.size)
        ops = OutboxRules.collapse(ops, OutboxOp.Delete("5", "m", createdAt = 0))
        assertEquals(listOf("5"), ops.map { it.id })
        // Nothing queues for a message being deleted; sends always queue.
        assertEquals(ops, OutboxRules.collapse(ops, update("6", "m", FlagPatch(isRead = false))))
        val send = OutboxOp.Send("7", "mail_1", SendPayload(to = listOf("a@b.com"), subject = "Hi"), createdAt = 0)
        assertEquals(2, OutboxRules.collapse(ops, send).size)
    }

    @Test
    fun theLatestSnoozeChoiceWins() {
        var ops = OutboxRules.collapse(emptyList(), OutboxOp.Snooze("1", "m", "a", "2026-12-01T08:00:00Z", createdAt = 0))
        ops = OutboxRules.collapse(ops, OutboxOp.Unsnooze("2", "m", "a", createdAt = 0))
        assertEquals(listOf("2"), ops.map { it.id })
    }

    @Test
    fun theQueueIsLaidOverTheList() {
        val list = listOf(message("a"), message("b"), message("c"), message("d"))
        val ops = listOf(
            update("1", "a", FlagPatch(isRead = true)),
            OutboxOp.Archive("2", "b", createdAt = 0),
            OutboxOp.Delete("3", "c", createdAt = 0),
            OutboxOp.Snooze("4", "d", "acc", "2026-12-01T08:00:00Z", createdAt = 0),
        )
        val inbox = OutboxRules.overlay(list, ops, "INBOX")
        assertEquals(listOf("a"), inbox.map { it.id })
        assertTrue(inbox.single().isRead)
        assertEquals(listOf("a", "b"), OutboxRules.overlay(list, ops, "archive").map { it.id })
        assertEquals(listOf("a", "d"), OutboxRules.overlay(list, ops, "SNOOZED").map { it.id })
    }

    @Test
    fun aReplayKeepsWhatCouldNotGoOutYet() = runTest {
        val ops = listOf(
            update("ok", "a", FlagPatch(isRead = true)),
            update("busy", "b", FlagPatch(isRead = true)),
            update("refused", "c", FlagPatch(isRead = true)),
            update("offline", "d", FlagPatch(isRead = true)),
            update("later", "e", FlagPatch(isRead = true)),
        )
        val replay = OutboxRules.replay(
            ops,
            run = { op ->
                when (op.id) {
                    "busy" -> throw IllegalStateException("503")
                    "refused" -> throw IllegalArgumentException("404")
                    "offline" -> throw IOException("offline")
                }
            },
            classify = { error ->
                when (error) {
                    is IOException -> FailureKind.NETWORK
                    is IllegalStateException -> FailureKind.TRANSIENT
                    else -> FailureKind.REJECTED
                }
            },
        )
        assertEquals(1, replay.succeeded)
        assertEquals(1, replay.dropped)
        val enqueuedMeanwhile = update("new", "f", FlagPatch(isStarred = true))
        val next = replay.applyTo(ops + enqueuedMeanwhile, ops)
        assertEquals(listOf("busy", "offline", "later", "new"), next.map { it.id })
        assertEquals(1, next.first().attempts)
        // An op that failed too often is dropped without being sent.
        val worn = update("worn", "g", FlagPatch(isRead = true)).copy(attempts = OutboxRules.MAX_ATTEMPTS)
        assertEquals(1, OutboxRules.replay(listOf(worn), run = { error("not sent") }, classify = { FailureKind.TRANSIENT }).dropped)
    }

    // ---------------------------------------------------------------- email html

    @Test
    fun scriptsHandlersAndScriptLinksAreStripped() {
        val dirty = """<p onclick="x()">Hi</p><script>alert(1)</script><a href=" javascript:alert(1)">x</a><iframe src="https://e"></iframe><form><input></form>"""
        val clean = EmailHtml.sanitize(dirty)
        assertFalse(clean.contains("<script", ignoreCase = true))
        assertFalse(clean.contains("onclick"))
        assertFalse(clean.contains("iframe"))
        assertFalse(clean.contains("<form"))
        assertTrue(clean.contains("href=\"#"))
        assertTrue(EmailHtml.document("<p>x</p>").contains("Content-Security-Policy"))
    }

    @Test
    fun aWholeDocumentKeepsItsStylesAndBody() {
        val html = """<html><head><style>p{}</style><title>t</title></head><body bgcolor="#eee" style="margin:0"><p>Body</p></body></html>"""
        assertEquals("""<style>p{}</style><div bgcolor="#eee" style="margin:0"><p>Body</p></div>""", EmailHtml.unwrap(html))
        assertEquals("<p>plain</p>", EmailHtml.unwrap("<p>plain</p>"))
        assertEquals("<p>Hi</p>", EmailHtml.trimTrailingEmpty("<p>Hi</p><div><br></div><br>&nbsp; "))
    }

    @Test
    fun linksNeverLoadInTheFrame() {
        assertTrue(EmailHtml.isInlineDocumentLoad("https://email.local/", loaded = true))
        assertTrue(EmailHtml.isInlineDocumentLoad("https://email.local/#top", loaded = true))
        assertFalse(EmailHtml.isInlineDocumentLoad("https://email.local@evil.com/", loaded = true))
        assertTrue(EmailHtml.isInlineDocumentLoad("about:blank", loaded = true))
        assertTrue(EmailHtml.isInlineDocumentLoad("data:text/html,x", loaded = false))
        assertFalse(EmailHtml.isInlineDocumentLoad("data:text/html,x", loaded = true))
        assertEquals(EmailHtml.LinkAction.BROWSER, EmailHtml.linkAction("HTTPS://example.com"))
        assertEquals(EmailHtml.LinkAction.SYSTEM, EmailHtml.linkAction("mailto:a@b.com"))
        assertEquals(EmailHtml.LinkAction.BLOCK, EmailHtml.linkAction("intent://x"))
    }
}
