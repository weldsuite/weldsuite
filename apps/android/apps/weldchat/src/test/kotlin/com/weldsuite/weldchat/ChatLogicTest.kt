package com.weldsuite.weldchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.weldsuite.weldchat.ui.avatarInitial
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import org.weldsuite.core.R as CoreR

class ChatLogicTest {
    private val zone: ZoneId = ZoneId.of("Europe/Amsterdam")
    private val now: Instant = Instant.parse("2026-11-27T14:00:00Z")
    private val texts = DmTexts(unknownMember = "Unknown", groupFallback = "Group", fallbackName = "Direct message")

    private fun channel(
        id: String = "ch_1",
        sectionId: String? = null,
        lastMessageAt: String? = null,
        lastReadAt: String? = null,
        hasReadState: Boolean = true,
        mentions: Int = 0,
    ) = ChatChannel(
        id = id,
        name = id,
        type = "public",
        sectionId = sectionId,
        lastMessageAt = lastMessageAt,
        lastReadAt = lastReadAt,
        hasReadState = hasReadState,
        unreadMentionCount = mentions,
    )

    private fun record(
        id: String,
        lastMessageAt: String? = "2026-11-27T10:00:00Z",
        lastReadAt: String? = "2026-11-27T11:00:00Z",
        mentions: Int = 0,
        muted: Boolean = false,
        type: String = "company",
    ) = RecordChat(
        id = id,
        name = id,
        entityType = type,
        entityId = "e_$id",
        lastMessageAt = lastMessageAt,
        lastReadAt = lastReadAt,
        unreadMentionCount = mentions,
        isMuted = muted,
    )

    @Test
    fun aChannelIsUnreadAfterItsReadMarkerOrWithAMention() {
        assertTrue(ChatLogic.isChannelUnread(channel(lastMessageAt = "2026-11-27T10:00:00Z", lastReadAt = "2026-11-27T09:00:00Z")))
        assertFalse(ChatLogic.isChannelUnread(channel(lastMessageAt = "2026-11-27T09:00:00Z", lastReadAt = "2026-11-27T10:00:00Z")))
        assertTrue("never read", ChatLogic.isChannelUnread(channel(lastMessageAt = "2026-11-27T09:00:00Z")))
        assertFalse("no read state: the detail", ChatLogic.isChannelUnread(channel(lastMessageAt = "2026-11-27T09:00:00Z", hasReadState = false)))
        assertTrue(ChatLogic.isChannelUnread(channel(hasReadState = false, mentions = 2)))
    }

    @Test
    fun channelsGroupBySectionWithTheRestUnderChannels() {
        val sections = listOf(ChatSection("s_1", "Team", 0))
        val groups = ChatLogic.groupSections(
            listOf(channel("a", "s_1"), channel("b"), channel("c", "s_gone")),
            sections,
            "Channels",
        )
        assertEquals(listOf("s_1", ChatLogic.UNSECTIONED_ID), groups.map { it.id })
        assertEquals(listOf("a"), groups[0].channels.map { it.id })
        assertEquals(listOf("b", "c"), groups[1].channels.map { it.id })
        val named = ChatLogic.groupSections(listOf(channel("b")), listOf(ChatSection("s_2", "Channels", 0)), "Channels", "Other Channels")
        assertEquals("next to a section called Channels the rest are Other Channels", listOf("s_2", ChatLogic.UNSECTIONED_ID), named.map { it.id })
        assertEquals("Other Channels", named[1].name)
        val filed = ChatLogic.groupSections(listOf(channel("a", "s_1")), sections, "Channels")
        assertEquals("no default group when every channel has a section", listOf("s_1"), filed.map { it.id })
    }

    @Test
    fun aWorkspaceWithoutSectionsAlwaysHasTheChannelsGroup() {
        val groups = ChatLogic.groupSections(emptyList(), emptyList(), "Channels")
        assertEquals(listOf(ChatLogic.UNSECTIONED_ID), groups.map { it.id })
        assertTrue(groups[0].channels.isEmpty())
    }

    @Test
    fun activityHoldsMentionsRepliesAndMissedCallsOnly() {
        assertTrue(ChatLogic.isActivityItem("weldchat", "chat_mention"))
        assertTrue(ChatLogic.isActivityItem("weldchat", "chat_thread_reply"))
        assertTrue(ChatLogic.isActivityItem("weldchat", "chat_missed_call"))
        assertFalse("a DM's message shows in the DM", ChatLogic.isActivityItem("weldchat", "chat_dm"))
        assertFalse("another app's notification", ChatLogic.isActivityItem("welddesk", "ticket_assigned"))
        assertEquals(ChatLogic.ActivityCategory.REPLIES, ChatLogic.activityCategory("chat_thread_reply"))
        assertEquals(ChatLogic.ActivityCategory.CALLS, ChatLogic.activityCategory("chat_missed_call"))
    }

    @Test
    fun mentionsOfYouOrEveryoneAreHighlighted() {
        assertTrue(ChatLogic.mentionsUser("hi <@u_1>", "u_1"))
        assertTrue(ChatLogic.mentionsUser("hi <@u_1:Ann>", "u_1"))
        assertTrue(ChatLogic.mentionsUser("all <@everyone>", "u_1"))
        assertFalse(ChatLogic.mentionsUser("hi <@u_10>", "u_1"))
    }

    @Test
    fun theAvatarFallbackIsTheFirstLetterAsOnThePlatform() {
        assertEquals("G", avatarInitial("Gert van den Berg"))
        assertEquals("A", avatarInitial("  ann"))
        assertEquals("?", avatarInitial(null))
    }

    @Test
    fun countLabelsCapAtTheLimit() {
        assertNull(ChatLogic.countLabel(null))
        assertEquals(UiText.Plural(R.plurals.weldchat_home_item_count, 3), ChatLogic.countLabel(3, 50))
        assertEquals(UiText.Res(R.string.weldchat_home_item_count_capped, listOf(50)), ChatLogic.countLabel(50, 50))
    }

    @Test
    fun reactionsAddAndRemoveAPerson() {
        val added = ChatLogic.withReaction(emptyMap(), "👍", "u_1", add = true)
        assertEquals(mapOf("👍" to listOf("u_1")), added)
        assertEquals(added, ChatLogic.withReaction(added, "👍", "u_1", add = true))
        assertEquals(emptyMap<String, List<String>>(), ChatLogic.withReaction(added, "👍", "u_1", add = false))
        assertEquals(
            listOf("a" to listOf("u"), "b" to listOf("u")),
            ChatLogic.reactionEntries(mapOf("b" to listOf("u"), "a" to listOf("u"), "c" to emptyList())),
        )
    }

    @Test
    fun typingNamesOneTwoOrMany() {
        val names = mapOf("u_ann" to "Ann", "u_bob" to "Bob")
        assertNull(ChatLogic.typingLabel(emptyList(), names, "Someone"))
        assertEquals(UiText.res(R.string.weldchat_channel_typing_one, "Ann"), ChatLogic.typingLabel(listOf("u_ann"), names, "Someone"))
        assertEquals(UiText.res(R.string.weldchat_channel_agent_working, "Someone"), ChatLogic.typingLabel(listOf("agt_1"), names, "Someone"))
        assertEquals(UiText.res(R.string.weldchat_channel_typing_two, "Ann", "someone"), ChatLogic.typingLabel(listOf("u_ann", "u_x"), names, "Someone"))
        assertEquals(UiText.res(R.string.weldchat_channel_typing_many, "Ann", 2), ChatLogic.typingLabel(listOf("u_ann", "u_bob", "u_x"), names, "Someone"))
    }

    @Test
    fun aReplyQuoteIsOneLineOrSaysWhatItWas() {
        val reply = ReplyReference("m_1", "m_1", 0, "u_ann", "Ann", null, "Hi\n<@u_bob>  there", false)
        assertEquals(UiText.Raw("Hi @Bob there"), ChatLogic.replyQuoteText(reply, mapOf("u_bob" to "Bob")))
        assertEquals(UiText.Res(R.string.weldchat_channel_attachment), ChatLogic.replyQuoteText(reply.copy(content = "<@file:f_1>", hasAttachments = true), emptyMap()))
        assertEquals(UiText.Res(R.string.weldchat_channel_original_message), ChatLogic.replyQuoteText(reply.copy(content = ""), emptyMap()))
    }

    @Test
    fun anOptimisticMessageIsSignedWithTheBestNameKnown() {
        assertEquals(UiText.Raw("Ann"), ChatLogic.optimisticAuthorName("u_ann", mapOf("u_ann" to "Ann"), listOf("Fallback")))
        assertEquals(UiText.Raw("Fallback"), ChatLogic.optimisticAuthorName("u_x", emptyMap(), listOf(null, "", "Fallback")))
        assertEquals(UiText.Res(R.string.weldchat_channel_you), ChatLogic.optimisticAuthorName(null, emptyMap(), listOf(null)))
    }

    @Test
    fun conversationLinksAndActionUrls() {
        assertEquals("https://app.weldsuite.eu/weldchat/ch_1", ChatLogic.conversationWebUrl("https://app.weldsuite.eu/", "ch_1", false, null))
        assertEquals("https://app.weldsuite.eu/weldchat/dm/u_ann", ChatLogic.conversationWebUrl("https://app.weldsuite.eu", "ch_1", true, "u_ann"))
        assertEquals("https://app.weldsuite.eu/weldchat/dm/group/ch_1", ChatLogic.conversationWebUrl("https://app.weldsuite.eu", "ch_1", true, null))

        assertEquals(ChatLogic.ConversationRef("ch_2", true), ChatLogic.conversationFromActionUrl("/weldchat/dm/ch_2?messageId=m"))
        assertEquals(ChatLogic.ConversationRef("ch_3", true), ChatLogic.conversationFromActionUrl("/weldchat/dm/group/ch_3"))
        assertEquals(ChatLogic.ConversationRef("ch_4", false), ChatLogic.conversationFromActionUrl("/weldchat/ch_4#m"))
        assertNull(ChatLogic.conversationFromActionUrl("/weldcrm/company/1"))
        assertNull(ChatLogic.conversationFromActionUrl(null))
        assertTrue(ChatLogic.isChatNotification("weldchat", "x"))
        assertTrue(ChatLogic.isChatNotification("system", "chat_mention"))
        assertFalse(ChatLogic.isChatNotification("weldmail", "mail_new"))
        assertEquals("1:05", ChatLogic.clock(65))
        assertEquals("0:00", ChatLogic.clock(-4))
    }

    @Test
    fun aDmIsNamedAfterThePeopleInIt() {
        fun dm(others: List<DmPerson>, stored: String = "", pinnedBy: List<String> = emptyList(), last: String? = null, read: String? = null) =
            DmLogic.conversation("ch_1", "dm", stored, others, last, read, pinnedBy, "u_me", false, null, false, texts)
        val ann = DmPerson("u_ann", "Ann", "ann@example.com", "a.png")
        val bob = DmPerson("u_bob", null, "bob@example.com")
        val single = dm(listOf(ann), pinnedBy = listOf("u_me"), last = "2026-11-27T10:00:00Z")
        assertEquals("Ann", single.name)
        assertEquals("a.png", single.picture)
        assertTrue(single.isPinned)
        assertTrue("never read", single.hasUnread)
        assertEquals("u_ann", single.peerUserId)
        val group = dm(listOf(ann, bob, DmPerson("u_x")), last = "2026-11-27T10:00:00Z", read = "2026-11-27T11:00:00Z")
        assertEquals("Ann, bob@example.com, Unknown", group.name)
        assertTrue(group.isGroup)
        assertNull(group.picture)
        assertNull(group.peerUserId)
        assertFalse(group.hasUnread)
        assertEquals("Direct message", dm(emptyList()).name)
        assertEquals("Stored", dm(emptyList(), stored = "Stored").name)
        assertEquals("people without an id don't count", "Ann", dm(listOf(ann, DmPerson(""))).name)
    }

    @Test
    fun dmsFilterThenPutPinnedAndNewestFirst() {
        val a = DmConversation("a", "A", lastMessageAt = "2026-11-27T10:00:00Z", hasUnread = true)
        val b = DmConversation("b", "B", lastMessageAt = "2026-11-27T12:00:00Z", isMuted = true)
        val c = DmConversation("c", "C", lastMessageAt = "2026-11-26T12:00:00Z", isPinned = true)
        assertEquals(listOf("c", "b", "a"), DmLogic.sorted(listOf(a, b, c), DmLogic.Filter.ALL).map { it.id })
        assertEquals(listOf("a"), DmLogic.sorted(listOf(a, b, c), DmLogic.Filter.UNREAD).map { it.id })
        assertEquals(listOf("c"), DmLogic.sorted(listOf(a, b, c), DmLogic.Filter.FAVOURITES).map { it.id })
        assertEquals(listOf("b"), DmLogic.sorted(listOf(a, b, c), DmLogic.Filter.MUTED).map { it.id })
        assertEquals(listOf("b", "a", "c"), DmLogic.recent(listOf(a, b, c)).map { it.id })
    }

    @Test
    fun recordChatsNeedAttentionForMentionsOrUnreadUnmutedMessages() {
        val unread = record("u", lastMessageAt = "2026-11-27T12:00:00Z", lastReadAt = "2026-11-27T10:00:00Z")
        assertTrue(RecordChatRules.isUnread(unread))
        assertFalse(RecordChatRules.isUnread(unread.copy(isMuted = true)))
        assertTrue(RecordChatRules.needsAttention(unread.copy(isMuted = true, unreadMentionCount = 1)))
        assertTrue("never read", RecordChatRules.hasUnreadMessages(record("n", lastReadAt = null)))
        assertTrue("a month old", RecordChatRules.isQuiet(record("q", lastMessageAt = "2026-10-01T10:00:00Z"), now))
        assertFalse(RecordChatRules.isQuiet(record("r"), now))
        assertTrue("no messages", RecordChatRules.isQuiet(record("e", lastMessageAt = null), now))
        assertEquals("Acme", RecordChatRules.name("Acme", "company-1"))
        assertEquals("company-1", RecordChatRules.name("", "company-1"))
    }

    @Test
    fun recordGroupsListTheTopChatsMentionsFirst() {
        val rows = mapOf(
            "company" to listOf(
                record("old", lastMessageAt = "2026-11-20T10:00:00Z", lastReadAt = "2026-11-21T10:00:00Z"),
                record("mention", mentions = 1),
                record("unread", lastMessageAt = "2026-11-27T12:00:00Z", lastReadAt = "2026-11-27T10:00:00Z"),
                record("quiet", lastMessageAt = "2026-09-01T10:00:00Z"),
            ),
        )
        val summary = listOf(RecordChatTypeSummary("company", 9, 1, 1), RecordChatTypeSummary("person", 0, 0, 0))
        val groups = RecordChatRules.groups(summary, rows, { false }, now)
        assertEquals(1, groups.size)
        assertEquals(listOf("mention", "unread", "old"), groups[0].rows.map { it.id })
        assertTrue("9 followed, 3 listed", groups[0].showAll)
        val collapsed = RecordChatRules.groups(summary, rows, { it == "company" }, now)
        assertEquals(listOf("mention", "unread"), collapsed[0].rows.map { it.id })
        assertFalse(collapsed[0].showAll)
    }

    @Test
    fun recordPagesCoverTheSummaryAndMergeOnce() {
        val rows = listOf(record("a", mentions = 2), record("b", lastMessageAt = "2026-11-27T12:00:00Z", lastReadAt = null))
        assertTrue(RecordChatRules.coversUnread(rows, RecordChatTypeSummary("company", 5, 1, 2)))
        assertFalse(RecordChatRules.coversUnread(rows, RecordChatTypeSummary("company", 5, 2, 2)))
        assertEquals(listOf("a", "b"), RecordChatRules.uniqueRows(listOf(rows, listOf(record("a")))).map { it.id })
        assertEquals(
            listOf("company", "task"),
            RecordChatRules.changedSummaryTypes(
                listOf(RecordChatTypeSummary("company", 1, 0, 0), RecordChatTypeSummary("person", 1, 0, 0)),
                listOf(RecordChatTypeSummary("company", 1, 1, 0), RecordChatTypeSummary("person", 1, 0, 0), RecordChatTypeSummary("task", 1, 0, 0)),
            ),
        )
    }

    @Test
    fun aPatchedRecordChatMovesItsTypesCounts() {
        val chat = record("a", lastMessageAt = "2026-11-27T12:00:00Z", lastReadAt = "2026-11-27T10:00:00Z", mentions = 1)
        val summary = listOf(RecordChatTypeSummary("company", 2, 1, 1))
        val rows = mapOf("company" to listOf(chat, record("b")))
        val read = RecordChatRules.patch(summary, rows, "a", RecordChatPatch(markRead = true), now)
        assertEquals(listOf(RecordChatTypeSummary("company", 2, 0, 0)), read.summary)
        assertEquals(0, read.rows["company"]?.first()?.unreadMentionCount)
        val gone = RecordChatRules.patch(summary, rows, "a", RecordChatPatch(unfollowed = true), now)
        assertEquals(listOf(RecordChatTypeSummary("company", 1, 0, 0)), gone.summary)
        assertEquals(listOf("b"), gone.rows["company"]?.map { it.id })
        val muted = RecordChatRules.patch(summary, rows, "a", RecordChatPatch(isMuted = true), now)
        assertEquals("a muted chat isn't unread, its mentions still count", listOf(RecordChatTypeSummary("company", 2, 0, 1)), muted.summary)
        val unknown = RecordChatRules.patch(summary, rows, "zzz", RecordChatPatch(markRead = true), now)
        assertEquals(summary, unknown.summary)
    }

    @Test
    fun personalEventsRefreshWhatTheyTouch() {
        val records = setOf("rc_1")
        val channels = setOf("ch_1")
        assertEquals(RecordChatRules.Refresh.SUMMARY, RecordChatRules.refresh(null, null, records, channels))
        assertEquals(RecordChatRules.Refresh.ALL, RecordChatRules.refresh("channel_new", "ch_9", records, channels))
        assertEquals(RecordChatRules.Refresh.NONE, RecordChatRules.refresh("dm_new", "ch_9", records, channels))
        assertEquals(RecordChatRules.Refresh.ALL, RecordChatRules.refresh("unread", "rc_1", records, channels))
        assertEquals(RecordChatRules.Refresh.NONE, RecordChatRules.refresh("unread", "ch_1", records, channels))
        assertEquals(RecordChatRules.Refresh.SUMMARY, RecordChatRules.refresh("unread", "ch_other", records, channels))
    }

    @Test
    fun recordsOpenInTheirOwnApp() {
        assertEquals(RecordChatRules.AppLink("WeldCRM", "weldcrm://company/c%201"), RecordChatRules.appLink("company", "c 1", null))
        assertEquals(RecordChatRules.AppLink("WeldFlow", "weldflow://task/p_1/t_1"), RecordChatRules.appLink("task", "t_1", "p_1"))
        assertNull("a task needs its project", RecordChatRules.appLink("task", "t_1", null))
        assertNull(RecordChatRules.appLink("sheet", "s_1", null))
        assertEquals("WeldFlow", RecordChatRules.app("project"))
        assertNull(RecordChatRules.app("doc"))
        assertEquals(R.string.weldchat_record_chats_groups_company, RecordChatRules.groupLabel("company"))
        assertNull(RecordChatRules.typeLabel("unknown"))
    }

    @Test
    fun daysAndTimesReadLikeAChatApp() {
        assertEquals(UiText.Res(CoreR.string.core_common_today), ChatDates.dayLabel(Instant.parse("2026-11-27T08:00:00Z"), now, zone))
        assertEquals(UiText.Res(CoreR.string.core_common_yesterday), ChatDates.dayLabel(Instant.parse("2026-11-26T08:00:00Z"), now, zone))
        assertEquals(UiText.Raw("Tuesday"), ChatDates.dayLabel(Instant.parse("2026-11-24T08:00:00Z"), now, zone, java.util.Locale.ENGLISH))
        assertEquals(UiText.Raw("Sunday 2 August"), ChatDates.dayLabel(Instant.parse("2026-08-02T08:00:00Z"), now, zone, java.util.Locale.ENGLISH))
        assertEquals(UiText.Raw("2 August 2025"), ChatDates.dayLabel(Instant.parse("2025-08-02T08:00:00Z"), now, zone, java.util.Locale.ENGLISH))
        assertEquals(UiText.Raw(""), ChatDates.listTime(null, now, zone))
        assertEquals(UiText.Res(CoreR.string.core_common_yesterday), ChatDates.listTime("2026-11-26T20:00:00Z", now, zone))
    }

    @Test
    fun activityGroupsAndShortTimes() {
        assertEquals(ChatDates.ActivityGroup.Today, ChatDates.activityGroup(Instant.parse("2026-11-27T07:00:00Z"), now, zone))
        assertEquals(ChatDates.ActivityGroup.Yesterday, ChatDates.activityGroup(Instant.parse("2026-11-26T07:00:00Z"), now, zone))
        assertEquals(ChatDates.ActivityGroup.ThisWeek, ChatDates.activityGroup(Instant.parse("2026-11-23T07:00:00Z"), now, zone))
        assertEquals(ChatDates.ActivityGroup.EarlierThisMonth, ChatDates.activityGroup(Instant.parse("2026-11-10T07:00:00Z"), now, zone))
        assertEquals(ChatDates.ActivityGroup.Month(YearMonth.of(2026, 9)), ChatDates.activityGroup(Instant.parse("2026-09-10T07:00:00Z"), now, zone))
        assertEquals(UiText.Res(R.string.weldchat_activity_now), ChatDates.activityTime(now.minusSeconds(20), now, zone))
        assertEquals(UiText.res(R.string.weldchat_activity_minutes_short, 5), ChatDates.activityTime(now.minusSeconds(300), now, zone))
        assertEquals(UiText.res(R.string.weldchat_activity_hours_short, 3), ChatDates.activityTime(now.minusSeconds(3 * 3600), now, zone))
        assertEquals(UiText.res(R.string.weldchat_activity_days_short, 2), ChatDates.activityTime(now.minusSeconds(2 * 86400), now, zone))
        assertEquals(UiText.Raw("17/11"), ChatDates.activityTime(now.minusSeconds(10 * 86400), now, zone))
        assertEquals(UiText.Res(R.string.weldchat_drafts_just_now), ChatDates.draftTime(now, now, zone))
        assertEquals(UiText.res(R.string.weldchat_drafts_hours_ago, 1), ChatDates.draftTime(now.minusSeconds(3600), now, zone))
    }

    @Test
    fun searchTabsFilterTheResults() {
        fun hit(content: String = "", vararg types: String) = SearchHitItem(
            id = "m",
            content = content,
            authorName = null,
            channelId = "ch",
            createdAt = "2026-11-27T10:00:00Z",
            attachments = types.map { ChatAttachment("f", "f", 1.0, it, "https://x/f") },
        )
        assertTrue(SearchTab.LINKS.matches(hit("see https://weldsuite.eu")))
        assertFalse(SearchTab.LINKS.matches(hit("no link")))
        assertTrue(SearchTab.PHOTOS.matches(hit("", "image/png")))
        assertFalse(SearchTab.PHOTOS.matches(hit("", "image/gif")))
        assertTrue(SearchTab.GIFS.matches(hit("", "image/gif")))
        assertTrue(SearchTab.VIDEOS.matches(hit("", "video/mp4")))
        assertTrue(SearchTab.AUDIO.matches(hit("", "audio/mp4")))
        assertTrue(SearchTab.DOCS.matches(hit("", "application/pdf")))
        assertFalse(SearchTab.DOCS.matches(hit("", "image/png")))
        assertTrue(SearchTab.ALL.matches(hit()))
        assertEquals(listOf("b", "a"), RecentSearches.adding(" b ", listOf("a", "b")))
        assertEquals(listOf("a"), RecentSearches.adding("  ", listOf("a")))
        assertEquals(RecentSearches.LIMIT, RecentSearches.adding("new", (1..20).map { "t$it" }).size)
    }

    @Test
    fun channelNamesAreNormalised() {
        assertEquals("q4-launch-plan", ChannelNames.normalize("Q4  Launch plan!"))
        assertEquals("a-b", ChannelNames.normalize("a - - b"))
        assertEquals(ChannelNames.MAX_LENGTH, ChannelNames.normalize("x".repeat(200)).length)
        assertEquals("marketing", ChannelNames.trimDashes("-marketing-"))
    }

    @Test
    fun pinsExpireAfterTheirDuration() {
        assertEquals(now.plusSeconds(86_400), PinDuration.DAY.expiresAt(now))
        assertEquals(now.plusSeconds(7 * 86_400), PinDuration.WEEK.expiresAt(now))
        assertNull(PinDuration.FOREVER.expiresAt(now))
    }

    @Test
    fun memberDetailsReadLikeThePlatform() {
        assertEquals(R.string.weldchat_member_roles_owner, MemberLogic.roleLabel("OWNER"))
        assertEquals(R.string.weldchat_member_roles_custom, MemberLogic.roleLabel("role_abc"))
        assertEquals(R.string.weldchat_member_roles_member, MemberLogic.roleLabel("SOMETHING"))
        assertEquals("15:00", MemberLogic.localTime(now, "Europe/Amsterdam"))
        assertEquals("—", MemberLogic.localTime(now, "Nowhere/Else"))
        assertEquals("GMT+1", MemberLogic.offset(now, "Europe/Amsterdam"))
        assertEquals("GMT+5:30", MemberLogic.offset(now, "Asia/Kolkata"))
        assertEquals("GMT-5", MemberLogic.offset(now, "America/New_York"))
        assertEquals("GMT", MemberLogic.offset(now, "UTC"))
        assertEquals(32.5, MemberLogic.parseHours(" 32,5 ") ?: 0.0, 0.0001)
        assertNull(MemberLogic.parseHours("lots"))
        assertEquals("Q3 plan", MemberLogic.quotedName("Created project 'Q3 plan'"))
        assertEquals("Ship", MemberLogic.quotedName("Created task \"Ship\""))
        assertEquals("Status changed", MemberLogic.sentenceCase("statusChanged"))
        assertEquals("Task", MemberLogic.entityTypeLabel("project_task"))
        assertEquals(UiText.Res(R.string.weldchat_member_activity_actions_created), MemberLogic.actionLabel("created"))
        assertEquals(UiText.Raw("merged"), MemberLogic.actionLabel("merged"))
    }

    @Test
    fun anActivityTimelineGroupsByDayActionAndRecord() {
        val entries = listOf(
            MemberActivityEntry("1", "created", "project_task", "t_1", "Created task 'Ship'", "2026-11-27T10:00:00Z"),
            MemberActivityEntry("2", "created", "project_task", "t_1", "Updated it", "2026-11-27T09:00:00Z"),
            MemberActivityEntry("3", "created", "project_task", "t_2", "No name", "2026-11-27T08:00:00Z"),
            MemberActivityEntry("4", "updated", "deal", "d_1", "Updated deal", "2026-11-25T08:00:00Z"),
        )
        val days = MemberLogic.timeline(entries, zone)
        assertEquals(listOf(LocalDate.of(2026, 11, 27), LocalDate.of(2026, 11, 25)), days.map { it.date })
        val event = days[0].events.single()
        assertEquals("created:project_task", event.id)
        assertEquals(3, event.entryCount)
        assertEquals(2, event.recordCount)
        assertEquals(listOf("t_1", "unnamed"), event.cards.map { it.id })
        assertEquals("Ship", event.cards[0].title)
        assertEquals(2, event.cards[0].entryCount)
        assertEquals("Task", event.cards[1].title)
    }

    @Test
    fun aTappedPushOpensTheRightPlace() {
        assertEquals(PushRoute.IncomingCall, PushRoute.of(mapOf("notificationType" to "chat_incoming_call")))
        assertEquals(PushRoute.None, PushRoute.of(mapOf("notificationType" to "push_test", "channelId" to "ch_1")))
        assertEquals(PushRoute.Conversation("ch_2", true), PushRoute.of(mapOf("notificationType" to "chat_missed_call", "actionUrl" to "/weldchat/ch_2")))
        assertEquals(PushRoute.None, PushRoute.of(mapOf("notificationType" to "chat_missed_call")))
        assertEquals(PushRoute.Conversation("ch_3", false), PushRoute.of(mapOf("notificationType" to "chat_mention", "chatChannelId" to "ch_3")))
        assertEquals(
            PushRoute.Conversation("ch_4", true),
            PushRoute.of(mapOf("notificationType" to "chat_dm", "chatChannelId" to "", "actionUrl" to "/weldchat/dm/ch_4")),
        )
        assertEquals(PushRoute.None, PushRoute.of(mapOf("notificationType" to "chat_dm")))
    }

    @Test
    fun weldchatLinksOpenTheirScreens() {
        assertEquals(DeepLink.Channel("ch_1"), DeepLink.parse("weldchat://channel/ch_1"))
        assertEquals(DeepLink.Dm("ch_2"), DeepLink.parse("weldchat://dm/ch_2"))
        assertEquals(DeepLink.User("u_1"), DeepLink.parse("weldchat://user/u_1"))
        assertEquals(DeepLink.Thread("m_1", "ch_1"), DeepLink.parse("weldchat://thread/m_1?channelId=ch_1"))
        assertNull("a thread needs its channel", DeepLink.parse("weldchat://thread/m_1"))
        assertEquals(DeepLink.Saved, DeepLink.parse("weldchat://later"))
        assertEquals(DeepLink.Settings, DeepLink.parse("weldchat://settings"))
        assertNull(DeepLink.parse("weldchat://channel"))
        assertNull(DeepLink.parse("weldmail://channel/ch_1"))
        assertNull(DeepLink.parse("weldchat://sso-callback?code=x"))
        assertNull(DeepLink.parse(null))
    }

    @Test
    fun theWaveformIsTheSameEveryTime() {
        assertEquals("a".hashCode(), Waveform.hash("a"))
        assertEquals("https://x/voice.m4a".hashCode(), Waveform.hash("https://x/voice.m4a"))
        val bars = Waveform.bars(Waveform.hash("https://x/voice.m4a"))
        assertEquals(Waveform.BAR_COUNT, bars.size)
        assertEquals(bars, Waveform.bars(Waveform.hash("https://x/voice.m4a")))
        assertTrue(bars.all { it in 0.25..1.0 })
        assertEquals(Waveform.bars(1), Waveform.bars(0))
        assertEquals(0.5f, Waveform.progress(500, 1000), 0.0001f)
        assertEquals(0f, Waveform.progress(500, 0), 0.0001f)
    }
}
