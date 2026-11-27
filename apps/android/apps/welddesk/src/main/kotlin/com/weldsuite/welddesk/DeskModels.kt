package com.weldsuite.welddesk

import java.time.Instant

/** Open, or closed. The server's value set is closed, but read leniently: anything else is open. */
enum class ConversationState(val value: String) {
    OPEN("open"),
    CLOSED("closed");

    companion object {
        fun of(value: String?): ConversationState = if (value == CLOSED.value) CLOSED else OPEN
    }
}

/** Where a conversation came in. A channel added later shows by its own name ([OTHER]). */
enum class DeskChannel(val value: String) {
    MESSENGER("messenger"),
    EMAIL("email"),
    PHONE("phone"),
    WHATSAPP("whatsapp"),
    SMS("sms"),
    API("api"),
    PORTAL("portal"),
    OTHER("");

    companion object {
        fun of(value: String?): DeskChannel = entries.firstOrNull { it != OTHER && it.value == value } ?: OTHER
    }
}

/** A reply to the customer, an internal note, or an event (closed, assigned, rated, …). */
enum class MessageKind(val value: String) {
    MESSAGE("message"),
    NOTE("note"),
    EVENT("event");

    companion object {
        fun of(value: String?): MessageKind = entries.firstOrNull { it.value == value } ?: MESSAGE
    }
}

enum class AuthorType(val value: String) {
    VISITOR("visitor"),
    AGENT("agent"),
    BOT("bot"),
    SYSTEM("system");

    companion object {
        fun of(value: String?): AuthorType = entries.firstOrNull { it.value == value } ?: SYSTEM
    }
}

/** The inbox's order; the chip steps through them in this order. */
enum class InboxSort(val value: String) {
    NEWEST("newest"),
    WAITING_LONGEST("waiting_longest"),
    OLDEST("oldest");

    /** The next one, as tapping the chip moves on: newest → waiting longest → oldest → newest. */
    fun next(): InboxSort = when (this) {
        NEWEST -> WAITING_LONGEST
        WAITING_LONGEST -> OLDEST
        OLDEST -> NEWEST
    }
}

enum class AssigneeFilter { ALL, MINE, UNASSIGNED }

/** What the inbox asks for. */
data class InboxQuery(
    val state: ConversationState = ConversationState.OPEN,
    val assignee: AssigneeFilter = AssigneeFilter.ALL,
    val sort: InboxSort = InboxSort.NEWEST,
    val search: String = "",
)

/** A conversation as the screens use it. */
data class Conversation(
    val id: String,
    val number: Int,
    val title: String?,
    val state: ConversationState,
    val channel: DeskChannel,
    /** The server's channel value, shown as is for a channel the app doesn't know. */
    val channelValue: String,
    val visitorId: String?,
    val name: String?,
    val email: String?,
    val assigneeId: String?,
    val waitingSince: Instant?,
    val lastMessageAt: Instant?,
    val updatedAt: Instant?,
    val lastMessagePreview: String?,
) {
    val isWaiting: Boolean get() = waitingSince != null
}

/** A file on a message. */
data class Attachment(
    val name: String?,
    val url: String,
    val contentType: String?,
    val size: Long?,
    val width: Double? = null,
    val height: Double? = null,
)

/** One entry of a conversation's timeline. */
data class Message(
    val id: String,
    val createdAt: Instant?,
    val conversationId: String,
    val kind: MessageKind,
    val body: String?,
    val authorType: AuthorType,
    val authorId: String?,
    val attachments: List<Attachment>,
    /** For an event: closed, reopened, assigned, unassigned, rated, … */
    val eventType: String?,
    val rating: Int?,
)

data class ConversationDetail(val conversation: Conversation, val messages: List<Message>)

/** What a reply or a change answers: the conversation after it, and the new timeline entry. */
data class ConversationChange(val conversation: Conversation, val message: Message)

/** A page of the inbox. */
data class InboxPage(val items: List<Conversation>, val hasMore: Boolean, val cursor: String?)

/** A teammate a conversation can be assigned to. */
data class Member(val userId: String, val name: String, val email: String, val picture: String?)

/** Close, reopen, or (un)assign. */
sealed interface ManageAction {
    data object Close : ManageAction
    data object Reopen : ManageAction
    /** Null unassigns. */
    data class Assign(val assigneeId: String?) : ManageAction
}

/** Where the app opens: from a notification, a link, or the tab bar. */
sealed interface DeskRoute {
    data object Inbox : DeskRoute
    data object Settings : DeskRoute
    data class Conversation(val id: String) : DeskRoute
}
