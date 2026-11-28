package com.weldsuite.welddesk

import java.util.Locale

/** The inbox request's parameters, as `GET /api/desk/conversations` takes them. */
data class InboxRequest(
    val state: String,
    val assigneeId: String?,
    val unassigned: Boolean?,
    val q: String?,
    val sort: String,
)

/** WeldDesk's rules, without Android: what the screens show and send. */
object DeskLogic {
    /** The inbox's page size. */
    const val PAGE_SIZE = 30

    /** How long the search waits for the typing to stop. */
    const val SEARCH_DEBOUNCE_MS = 300L

    /** A typing signal is repeated at most this often while the agent types. */
    const val TYPING_REPEAT_MS = 3_000L

    /** The agent stopped typing when nothing was typed for this long. */
    const val TYPING_IDLE_MS = 4_000L

    /** A visitor's typing clears by itself after this, when no stop arrives. */
    const val TYPING_EXPIRY_MS = 6_000L

    /** What the server takes on a reply: 10 MB, these types, ten of them. */
    const val MAX_ATTACHMENT_BYTES = 10L * 1024 * 1024
    const val MAX_ATTACHMENTS = 10
    val ATTACHMENT_TYPES = listOf(
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/csv",
        "application/zip",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    /** The query for the inbox's filters: "mine" is the signed-in person's user id. */
    fun inboxRequest(query: InboxQuery, userId: String?): InboxRequest {
        val search = query.search.trim().takeIf { it.isNotEmpty() }
        return InboxRequest(
            state = query.state.value,
            assigneeId = if (query.assignee == AssigneeFilter.MINE) userId?.takeIf { it.isNotEmpty() } else null,
            unassigned = if (query.assignee == AssigneeFilter.UNASSIGNED) true else null,
            q = search,
            sort = query.sort.value,
        )
    }

    /** A row's title: the customer's name or email; null for neither (the screen says "Conversation"). */
    fun rowTitle(conversation: Conversation): String? =
        conversation.name.nonBlank() ?: conversation.email.nonBlank()

    /** A row's second line: the last message, else the subject, else the email. */
    fun rowSubtitle(conversation: Conversation): String =
        conversation.lastMessagePreview.nonBlank() ?: conversation.title.nonBlank() ?: conversation.email.nonBlank().orEmpty()

    /** `#42 · Order question`, or `#42` without a subject. */
    fun numberLabel(conversation: Conversation): String {
        val number = "#${conversation.number}"
        return conversation.title.nonBlank()?.let { "$number · $it" } ?: number
    }

    /** The thread's title: the customer's name, their email, or `#42`. */
    fun threadTitle(conversation: Conversation): String =
        conversation.name.nonBlank() ?: conversation.email.nonBlank() ?: "#${conversation.number}"

    /** The time a row shows: the last message's, else the last change's. */
    fun rowTime(conversation: Conversation) = conversation.lastMessageAt ?: conversation.updatedAt

    /** Insert or replace a message by id, keeping the timeline in time order. */
    fun mergeMessage(messages: List<Message>, incoming: Message): List<Message> {
        val index = messages.indexOfFirst { it.id == incoming.id }
        if (index >= 0) return messages.toMutableList().also { it[index] = incoming }
        return (messages + incoming).sortedWith(compareBy(nullsLast()) { it.createdAt })
    }

    /** Whose a conversation is, as the header says it. */
    sealed interface AssigneeLabel {
        data object Unassigned : AssigneeLabel
        data object You : AssigneeLabel
        data class Teammate(val name: String) : AssigneeLabel
        /** Someone not (yet) in the loaded roster. */
        data object Someone : AssigneeLabel
    }

    fun assigneeLabel(assigneeId: String?, userId: String?, members: List<Member>?): AssigneeLabel = when {
        assigneeId.isNullOrEmpty() -> AssigneeLabel.Unassigned
        assigneeId == userId -> AssigneeLabel.You
        else -> members?.firstOrNull { it.userId == assigneeId }?.let { AssigneeLabel.Teammate(it.name) } ?: AssigneeLabel.Someone
    }

    /** The picker's search over names and emails. */
    fun filterMembers(members: List<Member>, search: String): List<Member> {
        val needle = search.trim().lowercase(Locale.ROOT)
        if (needle.isEmpty()) return members
        return members.filter { it.name.lowercase(Locale.ROOT).contains(needle) || it.email.lowercase(Locale.ROOT).contains(needle) }
    }

    /** The picker's roster from the team list: members with a user id, named by name, email or id. */
    fun member(userId: String?, name: String?, email: String?, picture: String?): Member? {
        val id = userId.nonBlank() ?: return null
        return Member(userId = id, name = name.nonBlank() ?: email.nonBlank() ?: id, email = email.orEmpty(), picture = picture.nonBlank())
    }

    /** `1.4 MB`; empty for an unknown or empty size. */
    fun formatFileSize(bytes: Long?): String {
        if (bytes == null || bytes <= 0) return ""
        val units = listOf("B", "KB", "MB", "GB")
        var value = bytes.toDouble()
        var unit = 0
        while (value >= 1024 && unit < units.lastIndex) {
            value /= 1024
            unit++
        }
        val rounded = if (unit == 0 || value >= 10) {
            Math.round(value).toString()
        } else {
            val tenths = Math.round(value * 10) / 10.0
            if (tenths == Math.floor(tenths)) tenths.toLong().toString() else tenths.toString()
        }
        return "$rounded ${units[unit]}"
    }

    fun isImage(contentType: String?): Boolean = contentType.orEmpty().lowercase(Locale.ROOT).startsWith("image/")

    /** Only http(s) links are opened from a thread; anything else (`javascript:`, `file:`) isn't. */
    fun isOpenableUrl(url: String?): Boolean {
        val text = url?.trim()?.lowercase(Locale.ROOT) ?: return false
        return text.startsWith("http://") || text.startsWith("https://")
    }

    /** Why a file can't go on a reply, or null when it can. */
    enum class AttachmentProblem { TOO_LARGE, TYPE_NOT_ALLOWED }

    fun attachmentProblem(contentType: String?, size: Long?): AttachmentProblem? = when {
        size != null && size > MAX_ATTACHMENT_BYTES -> AttachmentProblem.TOO_LARGE
        contentType == null || contentType.lowercase(Locale.ROOT) !in ATTACHMENT_TYPES -> AttachmentProblem.TYPE_NOT_ALLOWED
        else -> null
    }

    /** A file name the server keeps (it keeps its own safe copy too); never empty. */
    fun displayName(name: String?, fallback: String): String = name?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

    /** A realtime room member who is the visitor (`visitor:<id>`), not an agent. */
    fun isVisitor(userId: String): Boolean = userId.startsWith("visitor:")

    /**
     * The conversation a notification is about: its `conversationId`, a
     * `desk_conversation` entity, or the web link `/welddesk/inbox/<id>`.
     * Null for anything else (a ticket opens the inbox).
     */
    fun conversationIdFromPush(values: Map<String, String>): String? {
        values["conversationId"].nonBlank()?.let { return it }
        if (values["entityType"] == "desk_conversation") values["entityId"].nonBlank()?.let { return it }
        val link = values["actionUrl"].nonBlank() ?: return null
        val path = link.substringBefore('?').substringBefore('#').trimEnd('/')
        val marker = "/welddesk/inbox/"
        val index = path.indexOf(marker)
        if (index < 0) return null
        return path.substring(index + marker.length).takeIf { it.isNotEmpty() && '/' !in it }
    }

    /** Where a notification opens: its conversation, else the inbox. */
    fun routeForPush(values: Map<String, String>): DeskRoute =
        conversationIdFromPush(values)?.let { DeskRoute.Conversation(it) } ?: DeskRoute.Inbox

    /**
     * `welddesk://conversation/<id>`, `welddesk://settings` or
     * `welddesk://inbox`, as the Expo app's routes; null for another link
     * (AppAuth's `welddesk://sso-callback`).
     */
    fun routeForLink(link: String?): DeskRoute? {
        val text = link?.trim() ?: return null
        val prefix = "welddesk://"
        if (!text.startsWith(prefix, ignoreCase = true)) return null
        val path = text.substring(prefix.length).substringBefore('?').substringBefore('#').trim('/')
        val parts = path.split('/').filter { it.isNotEmpty() }
        return when {
            parts.isEmpty() -> DeskRoute.Inbox
            parts[0] == "inbox" || parts[0] == "(tabs)" -> DeskRoute.Inbox
            parts[0] == "settings" -> DeskRoute.Settings
            parts[0] == "conversation" && parts.size == 2 -> DeskRoute.Conversation(parts[1])
            else -> null
        }
    }

    private fun String?.nonBlank(): String? = this?.takeIf { it.isNotBlank() }
}

/**
 * A conversation room's typing and presence (`@weldsuite/realtime`'s
 * `RoomClient`): the server's snapshot on connect, then joins, leaves and
 * typing signals. Pure, so the room socket and its tests share it.
 */
data class RoomState(
    /** User id → name of whoever is typing. */
    val typing: Map<String, String> = emptyMap(),
    /** User ids in the room. */
    val present: Set<String> = emptySet(),
) {
    /** Names of the visitors typing. */
    val visitorsTyping: List<String> get() = typing.filterKeys(DeskLogic::isVisitor).values.toList()

    val visitorOnline: Boolean get() = present.any(DeskLogic::isVisitor)

    /** A typing signal ends by itself after [DeskLogic.TYPING_EXPIRY_MS]. */
    fun withoutTyping(userId: String): RoomState = copy(typing = typing - userId)

    companion object {
        /**
         * The state after one of the room's messages, given its `type` and
         * fields: `connected` (with `presence`), `presence:join`,
         * `presence:leave`, `typing`. Anything else leaves it as it was.
         */
        fun reduce(state: RoomState, type: String?, fields: RoomFields): RoomState = when (type) {
            "connected" -> state.copy(present = fields.presence.toSet(), typing = emptyMap())
            "presence:join" -> fields.userId?.let { state.copy(present = state.present + it) } ?: state
            "presence:leave" -> fields.userId?.let { state.copy(present = state.present - it, typing = state.typing - it) } ?: state
            "typing" -> {
                val userId = fields.userId
                when {
                    userId == null -> state
                    fields.isTyping -> state.copy(typing = state.typing + (userId to fields.userName.orEmpty()))
                    else -> state.copy(typing = state.typing - userId)
                }
            }
            else -> state
        }
    }
}

/** What [RoomState.reduce] reads of a message. */
data class RoomFields(
    val userId: String? = null,
    val userName: String? = null,
    val isTyping: Boolean = false,
    val presence: List<String> = emptyList(),
)

/**
 * When to send the agent's own typing signal: a start at most every
 * [DeskLogic.TYPING_REPEAT_MS], a stop once after it.
 */
class TypingThrottle {
    private var lastSent = 0L

    /** A keystroke at [now]: whether to send `typing:start`. */
    fun keystroke(now: Long): Boolean {
        if (now - lastSent <= DeskLogic.TYPING_REPEAT_MS) return false
        lastSent = now
        return true
    }

    /** Typing ended (idle, sent, left): whether to send `typing:stop`. */
    fun stop(): Boolean {
        if (lastSent == 0L) return false
        lastSent = 0L
        return true
    }
}
