package com.weldsuite.weldchat

// What an open conversation does with its messages and its composer,
// without the screen: the reply a message starts, the optimistic row of a
// send, when a thread is suggested, which sends the server has confirmed.
// Pure, so ConversationRulesTest covers them. The same steps as the iOS
// app's Channel/ChannelModel.swift.

object ConversationRules {
    /** How long after the last keystroke a draft is saved. */
    const val DRAFT_SAVE_DELAY_MS = 800L

    /** A burst of room events reloads the messages once, this long after the last. */
    const val ROOM_RELOAD_DELAY_MS = 150L

    /** The prefix of an optimistic message's id. */
    const val PENDING_PREFIX = "pending-"

    /**
     * `/ask <question>`: the platform's AI command. The app can't run it, so
     * it says so instead of posting the text.
     */
    fun isAskCommand(text: String): Boolean = text.startsWith("/ask ") && text.substring(5).isNotBlank()

    /** The reply [message] starts: the chain's root and depth carry on from its own reply. */
    fun replyReference(message: ChatMessage): ReplyReference = ReplyReference(
        messageId = message.id,
        rootId = message.replyTo?.rootId ?: message.id,
        depth = message.replyTo?.depth ?: 0,
        authorId = message.authorId,
        authorName = message.authorName,
        authorAvatar = message.authorAvatar,
        content = message.content,
        hasAttachments = message.hasAttachments || message.attachments.isNotEmpty(),
    )

    /** "Continue in a thread?": a reply deep in a chain, not while editing, where threads are on, not dismissed for its root. */
    fun showThreadSuggestion(reply: ReplyReference?, editing: Boolean, threadsEnabled: Boolean?, dismissedRoots: Set<String>): Boolean {
        if (reply == null || editing || threadsEnabled == false) return false
        return reply.depth >= ChatLogic.THREAD_SUGGESTION_DEPTH && reply.rootId !in dismissedRoots
    }

    /** The row a send shows at once, until the server's copy arrives. Its reply sits one level deeper. */
    fun optimisticMessage(
        tempId: String,
        channelId: String,
        authorId: String,
        authorName: String,
        authorAvatar: String?,
        text: String,
        hasFiles: Boolean,
        reply: ReplyReference?,
        createdAt: String,
    ): ChatMessage = ChatMessage(
        id = tempId,
        channelId = channelId,
        authorId = authorId,
        authorName = authorName,
        authorAvatar = authorAvatar,
        authorType = "user",
        content = text,
        type = "text",
        hasAttachments = hasFiles,
        replyTo = reply?.let { it.copy(depth = it.depth + 1) },
        createdAt = createdAt,
        pending = true,
    )

    /**
     * The sends still waiting for their server copy: a send whose message id
     * came back and is in [fetchedIds] is done. A null id means the send
     * hasn't answered yet.
     */
    fun unsettled(pendingSends: Map<String, String?>, fetchedIds: Set<String>): Map<String, String?> =
        pendingSends.filter { (_, serverId) -> serverId == null || serverId !in fetchedIds }

    /** [messages] with one message's pin set. */
    fun withPinned(messages: List<ChatMessage>, id: String, pinned: Boolean): List<ChatMessage> =
        messages.map { if (it.id == id) it.copy(isPinned = pinned) else it }

    /** [messages] with one message's text replaced, marked edited. */
    fun withEdit(messages: List<ChatMessage>, id: String, content: String, editedAt: String): List<ChatMessage> =
        messages.map { if (it.id == id) it.copy(content = content, editedAt = editedAt) else it }

    /** [messages] with one message's reactions changed by [userId]. */
    fun withReaction(messages: List<ChatMessage>, id: String, emoji: String, userId: String, add: Boolean): List<ChatMessage> =
        messages.map { if (it.id == id) it.copy(reactions = ChatLogic.withReaction(it.reactions, emoji, userId, add)) else it }

    /** The fetched page with the pins made here that the server hasn't caught up with. */
    fun withLocalPins(fetched: List<ChatMessage>, localPins: Set<String>): List<ChatMessage> =
        fetched.map { if (it.id in localPins && !it.isPinned) it.copy(isPinned = true) else it }

    /** An older page in front of what is loaded, without the ones already there. */
    fun prependOlder(existing: List<ChatMessage>, older: List<ChatMessage>): List<ChatMessage> {
        val known = existing.map { it.id }.toSet()
        return older.filter { it.id !in known } + existing
    }

    /** Whether [userId] reacted with [emoji]. */
    fun hasReacted(message: ChatMessage, emoji: String, userId: String): Boolean = message.reactions[emoji]?.contains(userId) == true

    /**
     * Where a message sits in the list as drawn (newest first, at the
     * bottom), or null when it isn't loaded.
     */
    fun listIndex(rowsOldestFirst: List<ChatMessage>, id: String): Int? {
        val index = rowsOldestFirst.indexOfFirst { it.id == id }
        return if (index < 0) null else rowsOldestFirst.size - 1 - index
    }
}
