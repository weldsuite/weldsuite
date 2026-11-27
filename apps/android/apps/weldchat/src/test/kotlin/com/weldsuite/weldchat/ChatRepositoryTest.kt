package com.weldsuite.weldchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.weldchat.models.AgentVisual
import org.weldsuite.api.weldchat.models.Attachment
import org.weldsuite.api.weldchat.models.Channel
import org.weldsuite.api.weldchat.models.ChannelMember
import org.weldsuite.api.weldchat.models.ChannelMetadata
import org.weldsuite.api.weldchat.models.CommonConcepts
import org.weldsuite.api.weldchat.models.CommonCrmRecord
import org.weldsuite.api.weldchat.models.DayHours
import org.weldsuite.api.weldchat.models.DmChannel
import org.weldsuite.api.weldchat.models.DmMember
import org.weldsuite.api.weldchat.models.MemberProfile
import org.weldsuite.api.weldchat.models.MemberStatus
import org.weldsuite.api.weldchat.models.Message
import org.weldsuite.api.weldchat.models.MessageMetadata
import org.weldsuite.api.weldchat.models.ProfileLink
import org.weldsuite.api.weldchat.models.SearchChannel
import org.weldsuite.api.weldchat.models.SearchHit
import org.weldsuite.api.weldchat.models.TeamMember as ApiTeamMember
import org.weldsuite.api.weldchat.models.TimeBreak
import org.weldsuite.api.weldchat.models.WorkingHours
import org.weldsuite.api.weldchat.models.ReplyReference as ApiReplyReference

/** The generated types to the app's: defaults for what the server leaves out. */
class ChatRepositoryTest {
    @Test
    fun aListedChannelCarriesItsReadStateADetailDoesNot() {
        val listed = Channel(
            id = "ch_1",
            name = "general",
            type = "public",
            createdAt = "2026-11-27T10:00:00Z",
            unreadMentionCount = 2,
            metadata = ChannelMetadata(pinnedBy = listOf("u_me")),
            members = listOf(ChannelMember(id = "cm_1", userId = "agt_1", memberType = "agent", name = "Helper")),
        ).toChatChannel()
        assertTrue(listed.hasReadState)
        assertEquals(2, listed.unreadMentionCount)
        assertEquals(listOf("u_me"), listed.pinnedBy)
        assertTrue(listed.members.single().isAgent)
        assertTrue("threads are on unless the server says otherwise", listed.threadsEnabled)
        val detail = Channel(id = "ch_1", name = "general", type = "public", createdAt = "2026-11-27T10:00:00Z").toChatChannel()
        assertFalse(detail.hasReadState)
        assertEquals("user", ChannelMember(id = "cm", userId = "u").toMember().memberType)
    }

    @Test
    fun anAttachmentNeedsAnAddress() {
        assertNull(Attachment(id = "f", fileName = "a.png").toChatAttachment())
        val bare = Attachment(url = "https://cdn.test/files/report.pdf?sig=1").toChatAttachment()
        assertEquals("report.pdf", bare?.fileName)
        assertEquals("https://cdn.test/files/report.pdf?sig=1", bare?.id)
        assertEquals("application/octet-stream", bare?.mimeType)
        assertEquals(0.0, bare?.fileSize ?: -1.0, 0.0)
    }

    @Test
    fun aMessageKeepsItsReplyKnownVisualsAndReactions() {
        val message = Message(
            id = "m_1",
            channelId = "ch_1",
            authorId = "u_ann",
            authorName = "Ann",
            content = "Hi",
            type = "text",
            createdAt = "2026-11-27T10:00:00Z",
            reactions = mapOf("👍" to listOf("u_bob")),
            attachments = listOf(Attachment(url = "https://x/a.png", mimeType = "image/png"), Attachment(id = "none")),
            metadata = MessageMetadata(
                replyTo = ApiReplyReference(messageId = "m_0", depth = 2.0, authorName = "Bob", content = "Earlier"),
                visuals = listOf(AgentVisual(type = "chart", title = "Sales"), AgentVisual(type = "hologram", title = "?")),
            ),
        ).toChatMessage()
        assertEquals(mapOf("👍" to listOf("u_bob")), message.reactions)
        assertEquals(1, message.attachments.size)
        assertEquals("m_0", message.replyTo?.rootId)
        assertEquals(2, message.replyTo?.depth)
        assertEquals("", message.replyTo?.authorId)
        assertEquals(listOf(AgentVisualRef("chart", "Sales")), message.visuals)
        assertEquals(0, message.threadReplyCount)
        assertFalse(message.isPinned)
    }

    @Test
    fun aDmIsNamedAndPinnedForTheCaller() {
        val dm = DmChannel(
            id = "ch_1",
            name = "",
            type = "dm",
            lastMessageAt = "2026-11-27T10:00:00Z",
            lastReadAt = "2026-11-27T09:00:00Z",
            metadata = ChannelMetadata(pinnedBy = listOf("u_me")),
            otherMembers = listOf(DmMember(userId = "u_ann", name = "Ann", picture = "a.png")),
        ).toDm("u_me", DmTexts("Unknown", "Group", "DM"))
        assertEquals("Ann", dm.name)
        assertEquals("a.png", dm.picture)
        assertTrue(dm.isPinned)
        assertTrue(dm.hasUnread)
        assertFalse(dm.isArchived)
    }

    @Test
    fun searchHitsDropInlineFileTokens() {
        val hit = SearchHit(
            id = "m",
            channelId = "ch",
            createdAt = "2026-11-27T10:00:00Z",
            content = "See <@file:f_1>",
            channel = SearchChannel(name = "general", type = "public"),
        ).toSearchHit()
        assertEquals("See ", hit.content)
        assertEquals("general", hit.channelName)
        assertNull(hit.authorName)
    }

    @Test
    fun presenceAndTeamMembers() {
        val presence = MemberStatus(userId = "u", status = "dnd", statusText = "", statusEmoji = "🎧").toPresence()
        assertEquals(PresenceStatus.DND, presence.status)
        assertNull(presence.statusText)
        assertEquals("🎧", presence.statusEmoji)
        assertEquals(PresenceStatus.OFFLINE, MemberStatus(userId = "u", status = "on-holiday").toPresence().status)
        val member = ApiTeamMember(id = "m", userId = "invited_1", role = "MEMBER", status = "PENDING", memberType = "INTERNAL", name = "").toTeamMember()
        assertNull("an empty name is no name", member.name)
        assertTrue(member.isPendingInvitee)
    }

    @Test
    fun aProfileReadsItsWeekAndLinks() {
        val profile = MemberProfile(
            id = "m",
            userId = "u",
            role = "OWNER",
            status = "ACTIVE",
            timezone = "Europe/Amsterdam",
            canEdit = true,
            hoursPerWeek = "32.50",
            links = listOf(ProfileLink(label = null, url = "https://x.test"), ProfileLink(label = "Empty", url = "")),
            workingHours = WorkingHours(
                monday = DayHours(isOpen = true, openTime = "09:00", closeTime = "17:00", breaks = listOf(TimeBreak(start = "12:00", end = null))),
                sunday = DayHours(),
            ),
        ).toProfile()
        assertEquals(listOf(ProfileLinkItem("https://x.test", "https://x.test")), profile.links)
        assertEquals(setOf(Weekday.MONDAY, Weekday.SUNDAY), profile.workingHours.keys)
        assertEquals(listOf(TimeRange("12:00", "")), profile.workingHours[Weekday.MONDAY]?.breaks)
        assertFalse(profile.workingHours[Weekday.SUNDAY]?.isOpen ?: true)
        assertEquals("32.50", profile.hoursPerWeek)
    }

    @Test
    fun commonConceptsShowOnlyOpportunitiesFromCrm() {
        val common = CommonConcepts(
            channels = emptyList(),
            projects = emptyList(),
            tasks = emptyList(),
            crm = listOf(CommonCrmRecord(id = "1", kind = "opportunity", name = "Deal"), CommonCrmRecord(id = "2", kind = "company", name = "Acme")),
            helpdesk = emptyList(),
        ).toCommon()
        assertEquals(listOf("1"), common.crm.map { it.id })
        assertFalse(common.isEmpty)
    }
}
