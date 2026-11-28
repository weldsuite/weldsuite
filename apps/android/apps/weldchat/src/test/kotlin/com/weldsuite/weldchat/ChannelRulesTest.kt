package com.weldsuite.weldchat

import com.weldsuite.weldchat.calls.ActiveChannelCall
import com.weldsuite.weldchat.calls.CallPeer
import com.weldsuite.weldchat.calls.CallType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChannelRulesTest {
    private val roster = listOf(
        TeamMember("m_1", "u_ann", "Ann", "ann@example.com"),
        TeamMember("m_2", "u_bob", null, "bob@example.com"),
        TeamMember("m_3", "u_cat", "Cat", null),
    )

    @Test
    fun theMentionPickerOffersAgentsFirst() {
        val agents = listOf(
            ChannelMemberInfo("cm_1", "agt_1", memberType = "agent", name = "Helper", agentIcon = "bot"),
            ChannelMemberInfo("cm_2", "agt_2", memberType = "agent", name = null),
            ChannelMemberInfo("cm_3", "u_ann", name = "Ann"),
        )
        val all = ChannelRules.mentionCandidates("", agents, roster)
        assertEquals(listOf("agt_1", "u_ann", "u_bob", "u_cat"), all.map { it.userId })
        assertTrue(all.first().isAgent)
        assertEquals("bob@example.com", all[2].name)
        assertEquals(listOf("u_bob"), ChannelRules.mentionCandidates("BOB@", agents, roster).map { it.userId })
        val many = (1..20).map { TeamMember("m$it", "u$it", "Person $it") }
        assertEquals(ChannelRules.MENTION_PEOPLE_LIMIT, ChannelRules.mentionCandidates("person", emptyList(), many).size)
    }

    @Test
    fun copyIsForTextAndCopiesNames() {
        val message = ChatMessage(id = "m", channelId = "c", authorId = "u", authorName = "U", content = "Hi <@u_ann> <@file:f>", createdAt = "2026-11-27T10:00:00Z")
        assertTrue(ChannelRules.canCopy(message))
        assertFalse(ChannelRules.canCopy(message.copy(content = " <@file:f> ")))
        assertEquals("Hi @Ann", ChannelRules.copyText(message, mapOf("u_ann" to "Ann")))
    }

    @Test
    fun theViewerGetsEveryPhotoOnceOldestFirst() {
        fun photo(id: String, url: String, mime: String = "image/png") = ChatAttachment(id, id, 1.0, mime, url)
        val messages = listOf(
            ChatMessage(id = "2", channelId = "c", authorId = "u", authorName = "Bob", content = "", createdAt = "2026-11-27T11:00:00Z", attachments = listOf(photo("b", "https://x/b"), photo("a", "https://x/a"))),
            ChatMessage(id = "1", channelId = "c", authorId = "u", authorName = "Ann", content = "", createdAt = "2026-11-27T10:00:00Z", attachments = listOf(photo("a", "https://x/a"), photo("d", "https://x/d.pdf", "application/pdf"))),
        )
        val images = ChannelRules.images(messages)
        assertEquals(listOf("https://x/a", "https://x/b"), images.map { it.url })
        assertEquals("Ann", images[0].authorName)
    }

    @Test
    fun headersPlaceholdersAndWelcomes() {
        val record = ChatChannel(id = "c", name = "company-1", type = "entity", entityDisplayName = "Acme")
        assertEquals("Acme", ChannelRules.displayName(record, "row"))
        assertEquals("row", ChannelRules.displayName(null, "row"))
        assertEquals("row", ChannelRules.displayName(ChatChannel(id = "c", name = "", type = "public"), "row"))
        assertEquals(UiText.Res(R.string.weldchat_composer_message_dm), ChannelRules.placeholder(ConversationKind.CHANNEL, ""))
        assertEquals(UiText.res(R.string.weldchat_composer_message_channel, "general"), ChannelRules.placeholder(ConversationKind.CHANNEL, "general"))
        assertEquals(UiText.res(R.string.weldchat_record_chats_message_placeholder, "Acme"), ChannelRules.placeholder(ConversationKind.RECORD, "Acme"))
        assertEquals(UiText.res(R.string.weldchat_channel_dm_conversation, "Ann"), ChannelRules.welcome(ConversationKind.DM, "Ann"))
        assertEquals(UiText.res(R.string.weldchat_channel_welcome, "x"), ChannelRules.welcome(ConversationKind.PRIVATE_CHANNEL, "x"))
        assertEquals(ConversationKind.RECORD, ConversationKind.of("entity"))
        assertEquals(ConversationKind.CHANNEL, ConversationKind.of(null))
    }

    @Test
    fun ownersManageAndMembersLeave() {
        val members = listOf(
            ChannelMemberInfo("1", "u_owner", role = "owner"),
            ChannelMemberInfo("2", "u_admin", role = "admin"),
            ChannelMemberInfo("3", "u_member", role = "member"),
        )
        assertEquals(ChannelPermissions(isOwner = true, canManage = true, canLeave = false), ChannelRules.permissions(members, "u_owner"))
        assertEquals(ChannelPermissions(isOwner = false, canManage = true, canLeave = true), ChannelRules.permissions(members, "u_admin"))
        assertEquals(ChannelPermissions(isOwner = false, canManage = false, canLeave = true), ChannelRules.permissions(members, "u_member"))
        val outsider = ChannelRules.permissions(members, "u_x")
        assertFalse(outsider.showActions)
    }

    @Test
    fun callsInTheHeader() {
        val call = ActiveChannelCall("call_1", CallType.VOICE)
        assertEquals(call, ChannelRules.joinableCall(call, null))
        assertNull("already in it", ChannelRules.joinableCall(call, "call_1"))
        assertNull(ChannelRules.joinableCall(null, null))
        assertEquals(CallPeer(name = "Ann", avatar = "a.png", isDirect = true), ChannelRules.callPeer(ConversationKind.DM, "Ann", "a.png"))
        assertEquals(CallPeer(name = "#general"), ChannelRules.callPeer(ConversationKind.CHANNEL, "general", null))
        assertEquals(CallPeer(name = null), ChannelRules.callPeer(ConversationKind.CHANNEL, "", null))
    }

    @Test
    fun theDmPeerAndTheirPresence() {
        val dm = DmConversation("d", "Ann", otherMembers = listOf(DmPerson("u_ann", "Ann")))
        assertEquals("u_ann", ChannelRules.peerUserId(dm, "Ann", roster))
        assertNull(ChannelRules.peerUserId(dm.copy(isGroup = true), "Ann", roster))
        assertEquals("u_cat", ChannelRules.peerUserId(null, "Cat", roster))
        assertNull(ChannelRules.peerUserId(null, "", roster))
        assertEquals(R.string.weldchat_channel_active_now, ChannelRules.presenceSubtitle("active"))
        assertEquals(R.string.weldchat_channel_offline, ChannelRules.presenceSubtitle("SUSPENDED"))
        assertNull(ChannelRules.presenceSubtitle(null))
    }

    @Test
    fun pinsAndInvites() {
        assertTrue(ChannelRules.canPin(2))
        assertFalse(ChannelRules.canPin(3))
        assertEquals(listOf("u_bob", "u_cat"), ChannelRules.invitable(roster, setOf("u_ann"), "").map { it.userId })
        assertEquals(listOf("u_bob"), ChannelRules.invitable(roster, setOf("u_ann"), " BOB ").map { it.userId })
    }
}
