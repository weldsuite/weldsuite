package com.weldsuite.weldchat.ui.screens

import com.weldsuite.weldchat.ChatAttachment
import com.weldsuite.weldchat.ChatBookmark
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.CommonConceptsInfo
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.DayHoursInfo
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.DmPerson
import com.weldsuite.weldchat.MemberActivityEntry
import com.weldsuite.weldchat.MemberLogic
import com.weldsuite.weldchat.MemberPresence
import com.weldsuite.weldchat.MemberProfileInfo
import com.weldsuite.weldchat.PresenceStatus
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.SearchHitItem
import com.weldsuite.weldchat.SearchTab
import com.weldsuite.weldchat.TeamMember
import com.weldsuite.weldchat.TimeRange
import com.weldsuite.weldchat.UiText
import com.weldsuite.weldchat.Weekday
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import org.weldsuite.core.R as CoreR

/** The rules of the list and create screens (ui/screens/ScreenRules.kt), as the iOS ScreenRulesTests. */
class ScreenRulesTest {
    // Fixtures

    /** 2026-03-04 12:00:00 UTC. */
    private val base: Instant = Instant.ofEpochSecond(1_772_625_600)

    private fun ago(seconds: Long): String = WeldDate.timestampString(base.minusSeconds(seconds))

    private fun member(userId: String, name: String?, email: String? = null, status: String = "ACTIVE") =
        TeamMember(id = "wm_$userId", userId = userId, name = name, email = email, status = status)

    private fun channel(id: String, name: String? = null, type: String = "public", last: String? = null) =
        ChatChannel(id = id, name = name ?: id, type = type, lastMessageAt = last, hasReadState = true)

    private fun dm(id: String, people: List<DmPerson>, last: String? = null, name: String? = null) = DmConversation(
        id = id,
        name = name ?: people.joinToString(", ") { it.displayName("Unknown") },
        picture = if (people.size == 1) people[0].picture else null,
        isGroup = people.size > 1,
        otherMembers = people,
        lastMessageAt = last,
    )

    private fun record(
        id: String,
        type: String = "company",
        last: String? = null,
        read: String? = null,
        muted: Boolean = false,
        mentions: Int = 0,
        following: Boolean = true,
        preview: String? = null,
    ) = RecordChat(
        id = id,
        name = id,
        entityType = type,
        entityId = "ent_$id",
        lastMessageAt = last,
        lastMessagePreview = preview,
        isFollowing = following,
        isMuted = muted,
        lastReadAt = read,
        unreadMentionCount = mentions,
    )

    private fun bookmark(channelType: String?, channelName: String?, content: String?) = ChatBookmark(
        id = "b1",
        messageId = "m1",
        channelId = "d1",
        createdAt = ago(10),
        messageContent = content,
        messageAuthorName = "Ann",
        channelName = channelName,
        channelType = channelType,
    )

    private val ann = DmPerson(userId = "u_ann", name = "Ann", email = "ann@x.test", picture = "https://x.test/ann.png")
    private val bob = DmPerson(userId = "u_bob", name = null, email = "bob@x.test", picture = null)

    // Drafts and saved

    @Test
    fun draftsAndSavedNameTheirConversation() {
        assertEquals("#general", SavedRules.conversationLabel("general", isDm = false))
        assertEquals("Ann", SavedRules.conversationLabel("Ann", isDm = true))

        val dms = listOf(dm("d1", listOf(ann)))
        val channels = listOf(channel("c1", "general"), channel("c2", "dm-raw", type = "dm"))
        assertEquals(KnownConversation("Ann", true), SavedRules.knownConversation("d1", dms, channels))
        assertEquals(false, SavedRules.knownConversation("c1", dms, channels)?.isDm)
        assertEquals(true, SavedRules.knownConversation("c2", emptyList(), channels)?.isDm)
        assertNull(SavedRules.knownConversation("zz", dms, channels))
    }

    @Test
    fun draftsAreNewestFirst() {
        val drafts = listOf(
            DraftItem("a", "c", "c", false, "x", ago(600)),
            DraftItem("b", "c", "c", false, "y", ago(5)),
        )
        assertEquals(listOf("b", "a"), SavedRules.sortedDrafts(drafts).map { it.id })
    }

    @Test
    fun aSavedMessageReadsItsConversationAndText() {
        val dms = listOf(dm("d1", listOf(ann)))
        assertEquals(UiText.Raw("Ann"), SavedRules.bookmarkConversation(bookmark("dm", "dm-raw", "x"), dms))
        assertEquals(UiText.Raw("general"), SavedRules.bookmarkConversation(bookmark("public", "general", "x"), dms))
        assertEquals(UiText.Res(R.string.weldchat_saved_unknown_channel), SavedRules.bookmarkConversation(bookmark("public", null, "x"), emptyList()))
        assertEquals(UiText.Raw("Hi @Ann"), SavedRules.bookmarkText(bookmark(null, null, " Hi <@u_ann> <@file:f1>"), mapOf("u_ann" to "Ann")))
        assertEquals(UiText.Res(R.string.weldchat_saved_unavailable), SavedRules.bookmarkText(bookmark(null, null, null), emptyMap()))
    }

    // Record chats

    @Test
    fun theEmptyRecordsListSaysWhy() {
        assertEquals(UiText.res(R.string.weldchat_record_chats_empty_search, "acme"), RecordsRules.emptyText(RecordsFilter.UNREAD, "acme"))
        assertEquals(UiText.Res(R.string.weldchat_record_chats_empty_following), RecordsRules.emptyText(RecordsFilter.FOLLOWING, ""))
        assertEquals(UiText.Res(R.string.weldchat_record_chats_empty_unread), RecordsRules.emptyText(RecordsFilter.UNREAD, ""))
        assertEquals(UiText.Res(R.string.weldchat_record_chats_empty_mentions), RecordsRules.emptyText(RecordsFilter.MENTIONS, ""))
        assertEquals(UiText.Res(R.string.weldchat_record_chats_empty_all), RecordsRules.emptyText(RecordsFilter.ALL, ""))
        assertEquals("task", RecordsRules.initialType("task"))
        assertNull(RecordsRules.initialType("invoice"))
        assertNull(RecordsRules.initialType(null))
        assertEquals(listOf("following", "unread", "mentions", "all"), RecordsFilter.entries.map { it.wire })
    }

    @Test
    fun aRowChangeShowsAtOnce() {
        val rows = listOf(record("a", last = ago(5), read = ago(50), mentions = 2), record("b"))
        val muted = RecordsRules.apply(ConversationPatch(isMuted = true), rows, "a", RecordsFilter.FOLLOWING, base)
        assertEquals(true, muted.first().isMuted)
        val read = RecordsRules.apply(ConversationPatch(hasUnread = false), rows, "a", RecordsFilter.FOLLOWING, base)
        assertEquals(0, read.first().unreadMentionCount)
        assertEquals(WeldDate.timestampString(base), read.first().lastReadAt)

        val unfollowed = RecordsRules.apply(ConversationPatch(isFollowing = false), rows, "a", RecordsFilter.FOLLOWING, base)
        assertEquals("only All lists chats you don't follow", listOf("b"), unfollowed.map { it.id })
        val unfollowedInAll = RecordsRules.apply(ConversationPatch(isFollowing = false), rows, "a", RecordsFilter.ALL, base)
        assertEquals(listOf("a", "b"), unfollowedInAll.map { it.id })
        assertEquals(false, unfollowedInAll.first().isFollowing)
    }

    @Test
    fun whenARowChangeNeedsTheServersList() {
        assertTrue("undoing a mark-read", RecordsRules.needsReload(ConversationPatch(hasUnread = true), rowListed = true))
        assertTrue("a follow put back on a row that left", RecordsRules.needsReload(ConversationPatch(isFollowing = true), rowListed = false))
        assertFalse(RecordsRules.needsReload(ConversationPatch(isFollowing = true), rowListed = true))
        assertFalse(RecordsRules.needsReload(ConversationPatch(isMuted = true), rowListed = true))
    }

    @Test
    fun aRecordRowsLook() {
        assertTrue(RecordsRules.isHighlighted(record("a", last = ago(5))))
        assertFalse("only followed chats ask for attention", RecordsRules.isHighlighted(record("a", last = ago(5), following = false)))
        assertFalse(RecordsRules.isHighlighted(record("a", last = ago(5), read = ago(1))))
        assertEquals(UiText.Raw("Hello"), RecordsRules.subtitle(record("a", preview = "Hello"), showType = false))
        assertEquals(UiText.Res(R.string.weldchat_record_chats_no_messages), RecordsRules.subtitle(record("a", preview = ""), showType = false))
        assertEquals(
            UiText.res(R.string.weldchat_record_chats_type_and_preview, UiText.Res(R.string.weldchat_record_chats_types_task), UiText.Raw("Hello")),
            RecordsRules.subtitle(record("a", type = "task", preview = "Hello"), showType = true),
        )
    }

    @Test
    fun whichPersonalEventsReloadTheRecords() {
        val rows = listOf(record("r1"))
        assertTrue(RecordsRules.isRelevant("channel_new", null, rows))
        assertTrue(RecordsRules.isRelevant("unread_update", "r1", rows))
        assertFalse(RecordsRules.isRelevant("unread_update", "c9", rows))
        assertFalse(RecordsRules.isRelevant("mention", null, rows))
    }

    // Search

    @Test
    fun searchFindsPeopleByNameOrEmail() {
        val roster = listOf(member("u1", "Ann Lee", "ann@x.test"), member("u2", null, "bob@x.test"))
        assertEquals(listOf("u1"), SearchRules.people(roster, "lee").map { it.userId })
        assertEquals(listOf("u2"), SearchRules.people(roster, "BOB@").map { it.userId })
        assertEquals(0, SearchRules.people(roster, "  ").size)
    }

    @Test
    fun searchResultsPerTabAndTheirFileLine() {
        val photo = SearchHitItem(
            id = "h1",
            content = "",
            authorName = "Ann",
            channelId = "c",
            createdAt = ago(5),
            attachments = listOf(ChatAttachment("a", "beach.png", 1.0, "image/png", "https://x.test/b")),
        )
        val text = SearchHitItem(id = "h2", content = "hi", authorName = "Ann", channelId = "c", createdAt = ago(5))
        assertEquals(listOf("h1", "h2"), SearchRules.results(listOf(photo, text), SearchTab.ALL).map { it.id })
        assertEquals(listOf("h1"), SearchRules.results(listOf(photo, text), SearchTab.PHOTOS).map { it.id })
        assertTrue(SearchRules.results(listOf(photo, text), SearchTab.PEOPLE).isEmpty())
        assertEquals(UiText.Raw("beach.png"), SearchRules.attachmentLabel(photo))
        assertNull(SearchRules.attachmentLabel(text))
        val nameless = photo.copy(attachments = listOf(ChatAttachment("a", "", 1.0, "", "https://x.test/b")))
        assertEquals(UiText.Res(R.string.weldchat_channel_attachment), SearchRules.attachmentLabel(nameless))
    }

    @Test
    fun recentSearchesStayOnTheDeviceAsAJsonList() {
        assertEquals(emptyList<String>(), RecentSearchStore.decode(null))
        assertEquals(emptyList<String>(), RecentSearchStore.decode("not json"))
        assertEquals(listOf("budget", "plan"), RecentSearchStore.decode(RecentSearchStore.encode(listOf("budget", "plan"))))
        assertEquals("[\"budget\",\"plan\"]", RecentSearchStore.encode(listOf("budget", "plan")))
        assertEquals(8, RecentSearchStore.decode(RecentSearchStore.encode((1..12).map { "q$it" })).size)
        assertEquals("weldchat.recentSearches", RecentSearchStore.KEY)
    }

    // A member

    @Test
    fun theMemberHeader() {
        val profile = MemberProfileInfo(
            id = "wm1",
            userId = "u1",
            name = null,
            email = "ann@x.test",
            role = "MEMBER",
            status = "ACTIVE",
            timezone = "UTC",
            canEdit = false,
        )
        assertEquals(UiText.Raw("ann@x.test"), MemberScreenRules.headerName(profile, MemberLoadState.READY))
        assertEquals(UiText.Raw("Ann"), MemberScreenRules.headerName(profile.copy(name = "Ann"), MemberLoadState.READY))
        assertEquals(UiText.Res(R.string.weldchat_member_fallback_name), MemberScreenRules.headerName(profile.copy(email = null), MemberLoadState.READY))
        assertEquals(UiText.Res(R.string.weldchat_member_not_found_title), MemberScreenRules.headerName(null, MemberLoadState.NOT_FOUND))
        assertEquals(UiText.Res(R.string.weldchat_member_profile_load_failed_title), MemberScreenRules.headerName(null, MemberLoadState.FAILED))
        assertEquals(UiText.Raw(""), MemberScreenRules.headerName(null, MemberLoadState.LOADING))

        assertEquals("🍔 Lunch", MemberScreenRules.customStatus(MemberPresence(PresenceStatus.ONLINE, "Lunch", "🍔")))
        assertEquals("Lunch", MemberScreenRules.customStatus(MemberPresence(PresenceStatus.ONLINE, "Lunch", null)))
        assertNull(MemberScreenRules.customStatus(MemberPresence(PresenceStatus.AWAY, null, null)))
        assertNull(MemberScreenRules.customStatus(null))

        assertEquals("nothing in common with yourself", listOf(MemberTab.OVERVIEW, MemberTab.ACTIVITY), MemberScreenRules.tabs(isSelf = true))
        assertEquals(listOf(MemberTab.OVERVIEW, MemberTab.COMMON, MemberTab.ACTIVITY), MemberScreenRules.tabs(isSelf = false))
    }

    @Test
    fun workingHours() {
        val text: (UiText) -> String = { it.toString() }
        assertNull(MemberScreenRules.schedule(emptyMap()))
        assertNull(MemberScreenRules.schedule(mapOf(Weekday.MONDAY to DayHoursInfo(isOpen = false))))
        val monday = DayHoursInfo(isOpen = true, openTime = "09:00", closeTime = "17:00", breaks = listOf(TimeRange("12:00", "12:30")))
        assertEquals(Weekday.entries.toList(), MemberScreenRules.schedule(mapOf(Weekday.MONDAY to monday))?.map { it.first })
        val range = text(UiText.res(R.string.weldchat_member_hours_range, "09:00", "17:00"))
        val breaks = text(UiText.Plural(R.plurals.weldchat_member_breaks, 1))
        assertEquals("$range  ($breaks 12:00–12:30)", MemberScreenRules.dayHours(monday, text))
        assertEquals(
            text(UiText.res(R.string.weldchat_member_hours_range, "—", "17:00")),
            MemberScreenRules.dayHours(DayHoursInfo(isOpen = true, openTime = null, closeTime = "17:00"), text),
        )
        assertEquals(text(UiText.Res(R.string.weldchat_member_not_working)), MemberScreenRules.dayHours(null, text))
    }

    @Test
    fun anEditIsSavedOnlyWhenItChanged() {
        assertNull(MemberScreenRules.commit(" Engineer ", "Engineer"))
        assertEquals("Lead", MemberScreenRules.commit(" Lead ", "Engineer"))
        assertEquals("empty clears the field", "", MemberScreenRules.commit("  ", "Engineer"))
        assertNull(MemberScreenRules.commit("", null))
    }

    @Test
    fun whatYouHaveInCommon() {
        assertEquals("In Progress", MemberScreenRules.capitalizeWords("in progress"))
        assertEquals("In_progress", MemberScreenRules.capitalizeWords("in_progress"))
        assertEquals("Straße Open", MemberScreenRules.capitalizeWords("straße open"))
        assertEquals("", MemberScreenRules.capitalizeWords(""))
        val delegated = CommonConceptsInfo.Task("t1", "Ship", "open", "delegated")
        val own = CommonConceptsInfo.Task("t2", "Ship", "open", "assignee")
        assertEquals(UiText.res(R.string.weldchat_member_common_delegated, "open"), MemberScreenRules.taskHint(delegated))
        assertEquals(UiText.Raw("open"), MemberScreenRules.taskHint(own))
        assertEquals("# general", MemberScreenRules.commonChannelLabel(CommonConceptsInfo.Channel("c", "general", "public", 3)))
        assertEquals("Ann, Bob", MemberScreenRules.commonChannelLabel(CommonConceptsInfo.Channel("d", "Ann, Bob", "dm", 3)))
        val info = CommonConceptsInfo(
            channels = listOf(CommonConceptsInfo.Channel("c", "general", "public", 3)),
            tasks = listOf(delegated, own),
        )
        assertEquals(3, MemberScreenRules.commonCount(info))
    }

    @Test
    fun timelineWording() {
        val today = LocalDate.of(2026, 3, 4)
        assertEquals(UiText.Res(CoreR.string.core_common_today), MemberScreenRules.dayLabel(today, today))
        assertEquals(UiText.Res(CoreR.string.core_common_yesterday), MemberScreenRules.dayLabel(today.minusDays(1), today))
        assertEquals(UiText.Raw("Monday, March 2"), MemberScreenRules.dayLabel(today.minusDays(2), today, java.util.Locale.ENGLISH))
        val utc = ZoneOffset.UTC
        assertEquals(UiText.Res(R.string.weldchat_member_activity_just_now), MemberScreenRules.eventTime(base.minusSeconds(20), base, utc))
        assertEquals(UiText.res(R.string.weldchat_member_activity_minutes_ago, 10), MemberScreenRules.eventTime(base.minusSeconds(600), base, utc))
        assertEquals(UiText.res(R.string.weldchat_member_activity_hours_ago, 3), MemberScreenRules.eventTime(base.minusSeconds(3 * 3600), base, utc))
        assertEquals(UiText.Raw("11:00"), MemberScreenRules.eventTime(base.minusSeconds(86_400 + 3600), base, utc))

        val entries = listOf(
            MemberActivityEntry("a1", "created", "project", "p1", "Created 'Apollo'", ago(60)),
            MemberActivityEntry("a2", "created", "project", "p2", "Created 'Gemini'", ago(120)),
        )
        val created = MemberLogic.events(entries, mapOf("p1" to "Apollo", "p2" to "Gemini"))[0]
        assertEquals(
            UiText.res(R.string.weldchat_member_activity_sentence, "Ann", "created", UiText.res(R.string.weldchat_member_activity_many, 2, "Project")),
            MemberScreenRules.sentence(created, "Ann", "created"),
        )
        assertEquals(
            UiText.res(R.string.weldchat_member_activity_sentence_no_name, "created", UiText.res(R.string.weldchat_member_activity_many, 2, "Project")),
            MemberScreenRules.sentence(created, null, "created"),
        )
        assertEquals(listOf("Apollo", "Gemini"), MemberScreenRules.cards(created).map { it.title })
        assertNull(MemberScreenRules.eventRepeats(created))

        val edits = listOf(
            MemberActivityEntry("e1", "updated", "project_task", "t1", "Updated", ago(60)),
            MemberActivityEntry("e2", "updated", "project_task", "t1", "Updated", ago(90)),
            MemberActivityEntry("e3", "updated", "project_task", "t1", "Updated", ago(99)),
        )
        val updated = MemberLogic.events(edits, emptyMap())[0]
        assertTrue("an unnamed card would repeat the sentence", MemberScreenRules.cards(updated).isEmpty())
        assertEquals(3, MemberScreenRules.eventRepeats(updated))
        assertEquals(UiText.res(R.string.weldchat_member_activity_sentence_no_name, "updated", UiText.Raw("Task")), MemberScreenRules.sentence(updated, null, "updated"))
    }

    @Test
    fun cardCountsAndIcons() {
        assertEquals(3, MemberScreenRules.cardCount(MemberLogic.RecordCard("x", "X", 3, 3, true)))
        assertEquals(4, MemberScreenRules.cardCount(MemberLogic.RecordCard("x", "X", 1, 4, true)))
        assertNull(MemberScreenRules.cardCount(MemberLogic.RecordCard("x", "X", 1, 1, true)))
        assertEquals("a project task is a task", EntityIcon.TASK, MemberScreenRules.entityIcon("project_task"))
        assertEquals(EntityIcon.FOLDER, MemberScreenRules.entityIcon("project"))
        assertEquals(EntityIcon.COMPANY, MemberScreenRules.entityIcon("crm_company"))
        assertEquals(EntityIcon.OTHER, MemberScreenRules.entityIcon("widget"))
    }

    @Test
    fun theTimezoneLine() {
        assertEquals("UTC · 12:00 (GMT)", MemberScreenRules.zoneLine("UTC", base))
        assertEquals("Nowhere/Else · —", MemberScreenRules.zoneLine("Nowhere/Else", base))
    }

    // New channel, new DM

    @Test
    fun newChannelSteps() {
        assertEquals(1, NewChannelRules.lastStep(isPrivate = false))
        assertEquals("a private channel picks its people", 2, NewChannelRules.lastStep(isPrivate = true))
        assertEquals("marketing", NewChannelRules.finalName("-marketing-"))
        assertFalse(NewChannelRules.canContinue(0, "--", creating = false))
        assertTrue(NewChannelRules.canContinue(0, "plan", creating = false))
        assertFalse(NewChannelRules.canContinue(1, "plan", creating = true))
        assertEquals(UiText.Res(R.string.weldchat_new_channel_next), NewChannelRules.primaryLabel(0, isPrivate = false, selectedCount = 0))
        assertEquals(UiText.Res(R.string.weldchat_new_channel_create), NewChannelRules.primaryLabel(1, isPrivate = false, selectedCount = 0))
        assertEquals(UiText.Res(R.string.weldchat_new_channel_next), NewChannelRules.primaryLabel(1, isPrivate = true, selectedCount = 2))
        assertEquals(UiText.Res(R.string.weldchat_new_channel_create), NewChannelRules.primaryLabel(2, isPrivate = true, selectedCount = 0))
        assertEquals(UiText.res(R.string.weldchat_new_channel_create_with_count, 2), NewChannelRules.primaryLabel(2, isPrivate = true, selectedCount = 2))
        assertEquals(R.string.weldchat_new_channel_title, NewChannelRules.title(0))
        assertEquals(R.string.weldchat_new_channel_people_title, NewChannelRules.title(2))
        assertTrue(NewChannelRules.isNameTaken(ApiException(409, null, null)))
        assertFalse(NewChannelRules.isNameTaken(ApiException(500, null, null)))
        assertFalse(NewChannelRules.isNameTaken(IllegalStateException()))

        val roster = listOf(member("me", "Me"), member("u1", "Ann", "ann@x.test"), member("invited_1", null, "new@x.test", status = "PENDING"))
        assertEquals(listOf("u1", "invited_1"), NewChannelRules.people(roster, "me", "").map { it.userId })
        assertEquals(listOf("u1"), NewChannelRules.people(roster, "me", "ANN").map { it.userId })
    }

    @Test
    fun newDmPicksPeopleWhoCanBeMessaged() {
        val roster = listOf(
            member("me", "Me"),
            member("u1", "Ann", "ann@x.test"),
            member("invited_1", null, "new@x.test", status = "PENDING"),
            member("pending_clerk_1", "Pat"),
        )
        assertEquals("not yourself, not invitees", listOf("u1"), NewDmRules.people(roster, "me", "").map { it.userId })
        assertEquals(listOf("u1"), NewDmRules.people(roster, "me", "x.test").map { it.userId })
        assertEquals(2, NewDmRules.minimum(isGroup = true))
        assertEquals(1, NewDmRules.minimum(isGroup = false))
        assertEquals(UiText.Res(R.string.weldchat_new_message_start), NewDmRules.startLabel(1))
        assertEquals(UiText.res(R.string.weldchat_new_message_start_with_count, 3), NewDmRules.startLabel(3))
        assertEquals(listOf("a", "b"), NewDmRules.toggled(listOf("a"), "b"))
        assertEquals(listOf("b"), NewDmRules.toggled(listOf("a", "b"), "a"))
    }

    // New message

    @Test
    fun recipientsAndTheirKeys() {
        assertEquals(MessageRecipient.Channel("c1", "general", false), NewMessageRules.recipient(channel("c1", "general")))
        assertEquals(
            "a 1:1 DM is its person",
            MessageRecipient.Person("u_ann", "Ann", "https://x.test/ann.png"),
            NewMessageRules.recipient(dm("d1", listOf(ann))),
        )
        assertEquals(MessageRecipient.Person("u_bob", "bob@x.test", null), NewMessageRules.recipient(dm("d1", listOf(bob))))
        assertEquals("dm:d2", NewMessageRules.recipient(dm("d2", listOf(ann, bob))).key)
        assertEquals("#general", MessageRecipient.Channel("c1", "general", true).label)
        assertEquals("channel:c1", MessageRecipient.Channel("c1", "general", true).key)
        assertEquals("a@x.test", NewMessageRules.recipient(member("u1", null, "a@x.test")).name)
    }

    @Test
    fun recentMixesConversationsNewestFirst() {
        val channels = (1..8).map { channel("c$it", last = ago(it * 100L)) }
        val dms = listOf(dm("d1", listOf(ann), last = ago(50)), dm("d2", listOf(ann, bob), last = ago(450)))
        val recent = NewMessageRules.recent(channels, dms)
        assertEquals(NewMessageRules.RECENT_COUNT, recent.size)
        assertEquals(
            listOf("p:u_ann", "channel:c1", "channel:c2", "channel:c3", "channel:c4", "dm:d2"),
            recent.map { it.key }.take(6),
        )
    }

    @Test
    fun peopleAndChannelsToPick() {
        val roster = listOf(
            member("me", "Me"),
            member("u_ann", "Ann"),
            member("u_cat", "Cat"),
            member("u_bea", "Bea", "bea@x.test"),
            member("invited_9", "Invitee", status = "PENDING"),
        )
        val recent = listOf(MessageRecipient.Person("u_ann", "Ann", null), MessageRecipient.Channel("c1", "general", false))
        assertEquals("by name, without Recent", listOf("Bea", "Cat"), NewMessageRules.people(roster, "me", "", recent).map { it.name })
        assertEquals("searching includes Recent", listOf("Ann"), NewMessageRules.people(roster, "me", "@an", recent).map { it.name })
        assertEquals(listOf("Bea"), NewMessageRules.people(roster, "me", "bea@", recent).map { it.name })

        val channels = listOf(channel("c1", "general"), channel("c2", "design"), channel("c3", "dev-ops", type = "private"))
        assertEquals(listOf("design", "dev-ops"), NewMessageRules.channels(channels, "", recent).map { it.name })
        assertEquals(listOf("design", "dev-ops"), NewMessageRules.channels(channels, "#de", recent).map { it.name })
        assertEquals("an @ search is for people", 0, NewMessageRules.channels(channels, "@de", recent).size)
        assertEquals("design", NewMessageRules.term("  #Design "))
    }

    @Test
    fun whereANewMessageGoes() {
        val picked = listOf(
            MessageRecipient.Channel("c1", "general", false),
            MessageRecipient.Person("u1", "Ann", null),
            MessageRecipient.Dm("d2", "Ann, Bob", emptyList()),
            MessageRecipient.Person("u2", "Bob", null),
        )
        val plan = NewMessageRules.split(picked)
        assertEquals(listOf("c1", "d2"), plan.conversations.map { it.id })
        assertEquals(listOf(false, true), plan.conversations.map { it.isDm })
        assertEquals(listOf("channel:c1", "dm:d2"), plan.conversations.map { it.key })
        assertEquals("the people share one DM", listOf("u1", "u2"), plan.people)

        var list = NewMessageRules.toggled(emptyList(), picked[0])
        list = NewMessageRules.toggled(list, picked[1])
        assertEquals(listOf("channel:c1", "p:u1"), list.map { it.key })
        list = NewMessageRules.toggled(list, picked[0])
        assertEquals(listOf("p:u1"), list.map { it.key })

        assertFalse(NewMessageRules.canSend(emptyList(), "hi", 0, sending = false))
        assertFalse(NewMessageRules.canSend(picked, "  ", 0, sending = false))
        assertTrue(NewMessageRules.canSend(picked, "  ", 1, sending = false))
        assertTrue(NewMessageRules.canSend(picked, "hi", 0, sending = false))
        assertFalse(NewMessageRules.canSend(picked, "hi", 0, sending = true))
    }
}
