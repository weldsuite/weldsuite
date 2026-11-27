package com.weldsuite.weldchat

import com.weldsuite.weldchat.realtime.RoomEvent
import com.weldsuite.weldchat.realtime.RoomEvents
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationRulesTest {
    private fun message(
        id: String,
        createdAt: String = "2026-11-27T10:00:00.000Z",
        replyTo: ReplyReference? = null,
        attachments: List<ChatAttachment> = emptyList(),
        hasAttachments: Boolean = false,
        reactions: Map<String, List<String>> = emptyMap(),
        isPinned: Boolean = false,
    ) = ChatMessage(
        id = id,
        channelId = "ch_1",
        authorId = "user_ann",
        authorName = "Ann",
        authorAvatar = "https://example.test/ann.png",
        content = "Hello <@user_bob>",
        createdAt = createdAt,
        replyTo = replyTo,
        attachments = attachments,
        hasAttachments = hasAttachments,
        reactions = reactions,
        isPinned = isPinned,
    )

    private fun reply(depth: Int, rootId: String = "msg_root") = ReplyReference(
        messageId = "msg_parent",
        rootId = rootId,
        depth = depth,
        authorId = "user_ann",
        authorName = "Ann",
        authorAvatar = null,
        content = "Earlier",
        hasAttachments = false,
    )

    @Test
    fun askCommandNeedsAQuestion() {
        assertTrue(ConversationRules.isAskCommand("/ask what is due?"))
        assertFalse(ConversationRules.isAskCommand("/ask "))
        assertFalse(ConversationRules.isAskCommand("/ask    "))
        assertFalse(ConversationRules.isAskCommand("/asking for a friend"))
        assertFalse(ConversationRules.isAskCommand("please /ask this"))
    }

    @Test
    fun aReplyToAPlainMessageStartsAChain() {
        val ref = ConversationRules.replyReference(message("msg_1"))
        assertEquals("msg_1", ref.messageId)
        assertEquals("msg_1", ref.rootId)
        assertEquals(0, ref.depth)
        assertEquals("Ann", ref.authorName)
        assertFalse(ref.hasAttachments)
    }

    @Test
    fun aReplyToAReplyKeepsTheChainsRootAndDepth() {
        val ref = ConversationRules.replyReference(message("msg_2", replyTo = reply(depth = 2)))
        assertEquals("msg_2", ref.messageId)
        assertEquals("msg_root", ref.rootId)
        assertEquals(2, ref.depth)
    }

    @Test
    fun attachmentsCountFromEitherTheFlagOrTheList() {
        val file = ChatAttachment("att_1", "a.pdf", 10.0, "application/pdf", "https://example.test/a.pdf")
        assertTrue(ConversationRules.replyReference(message("m", attachments = listOf(file))).hasAttachments)
        assertTrue(ConversationRules.replyReference(message("m", hasAttachments = true)).hasAttachments)
    }

    @Test
    fun aThreadIsSuggestedDeepInAChainOnly() {
        val deep = reply(depth = ChatLogic.THREAD_SUGGESTION_DEPTH)
        assertTrue(ConversationRules.showThreadSuggestion(deep, editing = false, threadsEnabled = true, dismissedRoots = emptySet()))
        assertTrue(ConversationRules.showThreadSuggestion(deep, editing = false, threadsEnabled = null, dismissedRoots = emptySet()))
        assertFalse(ConversationRules.showThreadSuggestion(reply(depth = 1), editing = false, threadsEnabled = true, dismissedRoots = emptySet()))
        assertFalse(ConversationRules.showThreadSuggestion(null, editing = false, threadsEnabled = true, dismissedRoots = emptySet()))
        assertFalse(ConversationRules.showThreadSuggestion(deep, editing = true, threadsEnabled = true, dismissedRoots = emptySet()))
        assertFalse(ConversationRules.showThreadSuggestion(deep, editing = false, threadsEnabled = false, dismissedRoots = emptySet()))
        assertFalse(ConversationRules.showThreadSuggestion(deep, editing = false, threadsEnabled = true, dismissedRoots = setOf("msg_root")))
    }

    @Test
    fun theOptimisticRowIsPendingWithItsReplyOneLevelDeeper() {
        val row = ConversationRules.optimisticMessage(
            tempId = "pending-1",
            channelId = "ch_1",
            authorId = "user_ann",
            authorName = "Ann",
            authorAvatar = null,
            text = "Hi",
            hasFiles = true,
            reply = reply(depth = 1),
            createdAt = "2026-11-27T10:00:00.000Z",
        )
        assertTrue(row.pending)
        assertEquals("user", row.authorType)
        assertEquals("text", row.type)
        assertTrue(row.hasAttachments)
        assertEquals(2, row.replyTo?.depth)
        assertNull(ConversationRules.optimisticMessage("p", "c", "u", "A", null, "x", false, null, "t").replyTo)
    }

    @Test
    fun aSendIsSettledOnceItsServerCopyArrives() {
        val pending = mapOf("pending-1" to null, "pending-2" to "msg_2", "pending-3" to "msg_3")
        val left = ConversationRules.unsettled(pending, setOf("msg_2"))
        assertEquals(setOf("pending-1", "pending-3"), left.keys)
        assertNull(left["pending-1"])
    }

    @Test
    fun pinsEditsAndReactionsChangeOneMessage() {
        val list = listOf(message("a"), message("b"))
        val pinned = ConversationRules.withPinned(list, "b", true)
        assertFalse(pinned[0].isPinned)
        assertTrue(pinned[1].isPinned)

        val edited = ConversationRules.withEdit(list, "a", "New text", "2026-11-27T11:00:00.000Z")
        assertEquals("New text", edited[0].content)
        assertEquals("2026-11-27T11:00:00.000Z", edited[0].editedAt)
        assertEquals("Hello <@user_bob>", edited[1].content)

        val reacted = ConversationRules.withReaction(list, "a", "👍", "user_bob", add = true)
        assertEquals(listOf("user_bob"), reacted[0].reactions["👍"])
        assertTrue(ConversationRules.hasReacted(reacted[0], "👍", "user_bob"))
        assertFalse(ConversationRules.hasReacted(reacted[1], "👍", "user_bob"))
        val undone = ConversationRules.withReaction(reacted, "a", "👍", "user_bob", add = false)
        assertTrue(undone[0].reactions.isEmpty())
    }

    @Test
    fun pinsMadeHereStayUntilTheServerHasThem() {
        val fetched = listOf(message("a"), message("b", isPinned = true))
        val shown = ConversationRules.withLocalPins(fetched, setOf("a"))
        assertTrue(shown.all { it.isPinned })
        assertFalse(ConversationRules.withLocalPins(fetched, emptySet())[0].isPinned)
    }

    @Test
    fun anOlderPageGoesInFrontWithoutDuplicates() {
        val existing = listOf(message("c"), message("d"))
        val older = listOf(message("a"), message("b"), message("c"))
        assertEquals(listOf("a", "b", "c", "d"), ConversationRules.prependOlder(existing, older).map { it.id })
    }

    @Test
    fun theListIndexCountsFromTheNewest() {
        val rows = listOf(message("a"), message("b"), message("c"))
        assertEquals(0, ConversationRules.listIndex(rows, "c"))
        assertEquals(2, ConversationRules.listIndex(rows, "a"))
        assertNull(ConversationRules.listIndex(rows, "z"))
    }

    @Test
    fun roomMessagesThatChangeTheConversationReloadIt() {
        listOf("message", "reaction", "pin", "channel:updated").forEach { type ->
            assertEquals(RoomEvent.Changed, RoomEvents.parse(buildJsonObject { put("type", type) }, "user_ann"))
        }
        assertNull(RoomEvents.parse(buildJsonObject { put("type", "connected") }, "user_ann"))
        assertNull(RoomEvents.parse(buildJsonObject { put("other", "x") }, "user_ann"))
    }

    @Test
    fun typingIsSomeoneElsesOnly() {
        val started = buildJsonObject {
            put("type", "typing")
            put("userId", "user_bob")
            put("isTyping", true)
        }
        assertEquals(RoomEvent.Typing("user_bob", true), RoomEvents.parse(started, "user_ann"))
        assertNull(RoomEvents.parse(started, "user_bob"))
        val stopped = buildJsonObject {
            put("type", "typing")
            put("userId", "user_bob")
        }
        assertEquals(RoomEvent.Typing("user_bob", false), RoomEvents.parse(stopped, "user_ann"))
        val noUser = buildJsonObject {
            put("type", "typing")
            put("isTyping", JsonPrimitive(true))
        }
        assertNull(RoomEvents.parse(noUser, "user_ann"))
    }
}
