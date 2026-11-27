package com.weldsuite.weldchat

import org.weldsuite.core.WeldDate
import java.time.Instant

// What the screens use. Mapped from the generated API types in
// ChatRepository.kt and nowhere else (the calls have their own, in calls/),
// so a change in the generated names stays there. The same models as the
// iOS app's ChatStore.swift.

/** A channel, a DM or a record chat row, with the caller's read state. */
data class ChatChannel(
    val id: String,
    val name: String,
    val type: String,
    val description: String? = null,
    val topic: String? = null,
    val isArchived: Boolean = false,
    val threadsEnabled: Boolean = true,
    val memberCount: Int? = null,
    val lastMessageAt: String? = null,
    val lastMessagePreview: String? = null,
    val sectionId: String? = null,
    val entityType: String? = null,
    val entityId: String? = null,
    val entityDisplayName: String? = null,
    val isMuted: Boolean = false,
    /** Null: never read. Only meaningful when [hasReadState]. */
    val lastReadAt: String? = null,
    /** The answer carried the caller's read state (the list does, the detail doesn't). */
    val hasReadState: Boolean = false,
    val unreadMentionCount: Int = 0,
    val pinnedBy: List<String> = emptyList(),
    val members: List<ChannelMemberInfo> = emptyList(),
) {
    val isPrivate: Boolean get() = type == "private"
    val isDm: Boolean get() = type == "dm"
    val isRecord: Boolean get() = type == "entity"
}

/** A member of a channel: a person or a WeldAgent. */
data class ChannelMemberInfo(
    val id: String,
    val userId: String,
    val memberType: String = "user",
    val role: String? = null,
    val isMuted: Boolean = false,
    val name: String? = null,
    val email: String? = null,
    val picture: String? = null,
    val agentIcon: String? = null,
) {
    val isAgent: Boolean get() = memberType == "agent"
}

/** The caller's own membership row (mute and notification level). */
data class ChatMembership(
    val id: String,
    val isMuted: Boolean,
    val notificationPreference: NotificationLevel,
)

enum class NotificationLevel(val wire: String) {
    ALL("all"),
    MENTIONS("mentions"),
    NONE("none"),
    ;

    companion object {
        fun of(wire: String?): NotificationLevel = entries.firstOrNull { it.wire == wire } ?: ALL
    }
}

/** Someone in a DM. [displayName] needs the fallback text, so the UI asks [ChatTexts]. */
data class DmPerson(
    val userId: String,
    val name: String? = null,
    val email: String? = null,
    val picture: String? = null,
) {
    fun displayName(unknown: String): String = name ?: email ?: unknown
}

/** A direct message as the DM list and Home show it (`mapDm`). */
data class DmConversation(
    val id: String,
    val name: String,
    val picture: String? = null,
    val type: String = "dm",
    val isGroup: Boolean = false,
    val otherMembers: List<DmPerson> = emptyList(),
    val isMuted: Boolean = false,
    val isPinned: Boolean = false,
    val hasUnread: Boolean = false,
    val unreadCount: Int = 0,
    val lastMessagePreview: String? = null,
    val lastMessageAt: String? = null,
    val isArchived: Boolean = false,
) {
    /** The other person in a 1:1 conversation. */
    val peerUserId: String? get() = if (isGroup) null else otherMembers.firstOrNull()?.userId
}

data class ChatSection(val id: String, val name: String, val position: Int)

data class ChatAttachment(
    val id: String,
    val fileName: String,
    val fileSize: Double,
    val mimeType: String,
    val url: String,
) {
    val isImage: Boolean get() = mimeType.lowercase().startsWith("image/")
    val isAudio: Boolean get() = mimeType.lowercase().startsWith("audio/")
}

/** An inline reply's quote (`metadata.replyTo`). */
data class ReplyReference(
    val messageId: String,
    val rootId: String,
    val depth: Int,
    val authorId: String,
    val authorName: String,
    val authorAvatar: String?,
    val content: String,
    val hasAttachments: Boolean,
)

data class AgentVisualRef(val kind: String, val title: String)

data class ChatMessage(
    val id: String,
    val channelId: String,
    val authorId: String,
    val authorName: String,
    val authorAvatar: String? = null,
    val authorType: String? = null,
    val content: String,
    val type: String = "text",
    val parentId: String? = null,
    val threadReplyCount: Int = 0,
    val editedAt: String? = null,
    val isPinned: Boolean = false,
    val hasAttachments: Boolean = false,
    val attachments: List<ChatAttachment> = emptyList(),
    val reactions: Map<String, List<String>> = emptyMap(),
    val replyTo: ReplyReference? = null,
    val visuals: List<AgentVisualRef> = emptyList(),
    val createdAt: String,
    /** An optimistic row shown while the send runs. */
    val pending: Boolean = false,
) {
    val isSystem: Boolean get() = type == "system"
    val isAgent: Boolean get() = authorType == "agent"
    val instant: Instant? get() = WeldDate.parse(createdAt)
}

/** A record chat (a chat on a company, person, task, …) with the caller's state. */
data class RecordChat(
    val id: String,
    val name: String,
    val entityType: String,
    val entityId: String,
    val entityDisplayName: String? = null,
    val lastMessageAt: String? = null,
    val lastMessagePreview: String? = null,
    val isFollowing: Boolean = true,
    val isMuted: Boolean = false,
    val lastReadAt: String? = null,
    val unreadMentionCount: Int = 0,
) {
    val displayName: String get() = RecordChatRules.name(entityDisplayName, name)
}

data class RecordChatTypeSummary(val type: String, val followed: Int, val unread: Int, val mentions: Int)

data class TeamMember(
    val id: String,
    val userId: String,
    val name: String? = null,
    val email: String? = null,
    val picture: String? = null,
    val role: String = "MEMBER",
    val status: String = "ACTIVE",
    val memberType: String = "INTERNAL",
) {
    val displayName: String get() = name ?: email ?: "?"

    /** Invited, not joined yet: chat-api refuses a DM before then. */
    val isPendingInvitee: Boolean
        get() = status.uppercase() == "PENDING" || userId.startsWith("invited_") || userId.startsWith("pending_clerk_")
}

data class ActivityNotification(
    val id: String,
    val title: String,
    val body: String? = null,
    val category: String,
    val notificationType: String,
    val entityType: String? = null,
    val entityId: String? = null,
    val actionUrl: String? = null,
    val isRead: Boolean,
    val createdAt: String,
    val actorName: String? = null,
    val actorAvatar: String? = null,
)

data class ChatDraft(val id: String, val channelId: String?, val content: String, val updatedAt: String)

data class ChatBookmark(
    val id: String,
    val messageId: String,
    val channelId: String,
    val note: String? = null,
    val createdAt: String,
    val messageContent: String? = null,
    val messageAuthorName: String? = null,
    val messageAuthorAvatar: String? = null,
    val channelName: String? = null,
    val channelType: String? = null,
)

data class SearchHitItem(
    val id: String,
    val content: String,
    /** Null when the server sent none; the UI shows "Unknown author". */
    val authorName: String?,
    val authorAvatar: String? = null,
    val channelId: String,
    val channelName: String? = null,
    val channelType: String? = null,
    val createdAt: String,
    val attachments: List<ChatAttachment> = emptyList(),
)

enum class PresenceStatus(val wire: String) {
    ONLINE("online"),
    BUSY("busy"),
    AWAY("away"),
    DND("dnd"),
    OFFLINE("offline"),
    ;

    companion object {
        fun of(wire: String?): PresenceStatus = entries.firstOrNull { it.wire == wire } ?: OFFLINE
    }
}

data class MemberPresence(val status: PresenceStatus, val statusText: String? = null, val statusEmoji: String? = null)

data class ProfileLinkItem(val label: String, val url: String)

data class TimeRange(val start: String, val end: String)

data class DayHoursInfo(
    val isOpen: Boolean,
    val openTime: String? = null,
    val closeTime: String? = null,
    val breaks: List<TimeRange> = emptyList(),
)

enum class Weekday(val wire: String) {
    MONDAY("monday"),
    TUESDAY("tuesday"),
    WEDNESDAY("wednesday"),
    THURSDAY("thursday"),
    FRIDAY("friday"),
    SATURDAY("saturday"),
    SUNDAY("sunday"),
}

data class MemberProfileInfo(
    val id: String,
    val userId: String,
    val name: String? = null,
    val email: String? = null,
    val picture: String? = null,
    val role: String,
    val status: String,
    val title: String? = null,
    val bio: String? = null,
    val phone: String? = null,
    val location: String? = null,
    val pronouns: String? = null,
    val links: List<ProfileLinkItem> = emptyList(),
    /** As the server sends it: a decimal string. */
    val hoursPerWeek: String? = null,
    val workingHours: Map<Weekday, DayHoursInfo> = emptyMap(),
    val timezone: String,
    val canEdit: Boolean,
)

/** A change to one profile field; empty text clears it. */
enum class ProfileField { TITLE, BIO, PHONE, LOCATION, PRONOUNS, HOURS_PER_WEEK }

data class CommonConceptsInfo(
    val channels: List<Channel> = emptyList(),
    val projects: List<Project> = emptyList(),
    val tasks: List<Task> = emptyList(),
    val crm: List<Crm> = emptyList(),
    val helpdesk: List<Helpdesk> = emptyList(),
) {
    data class Channel(val id: String, val name: String, val type: String, val memberCount: Int)
    data class Project(val id: String, val name: String, val status: String?)
    data class Task(val id: String, val title: String, val status: String, val role: String)
    data class Crm(val id: String, val kind: String, val name: String, val status: String?)
    data class Helpdesk(val id: String, val kind: String, val subject: String, val status: String)

    val isEmpty: Boolean get() = channels.isEmpty() && projects.isEmpty() && tasks.isEmpty() && crm.isEmpty() && helpdesk.isEmpty()
}

data class MemberActivityEntry(
    val id: String,
    val action: String,
    val entityType: String,
    val entityId: String,
    val description: String,
    val createdAt: String,
)

/** One page of a list, and where the next one starts. */
data class Page<T>(val items: List<T>, val cursor: String?, val hasMore: Boolean)

/** A change made from a conversation's menu, swipe or header, shown at once. */
data class ConversationPatch(
    val isMuted: Boolean? = null,
    val isPinned: Boolean? = null,
    val hasUnread: Boolean? = null,
    val archived: Boolean? = null,
    val isFollowing: Boolean? = null,
)

/** A change made from a record chat's menu, shown before the server confirms it. */
data class RecordChatPatch(
    val isMuted: Boolean? = null,
    /** `true`: read up to now. */
    val markRead: Boolean = false,
    /** `true`: unfollowed, so the chat leaves Home. */
    val unfollowed: Boolean = false,
)

enum class RecordRefreshKind { ALL, SUMMARY }

/** Coalesces the record chat reloads a busy chat's events ask for. */
class RecordRefreshQueue {
    var pending: RecordRefreshKind? = null
        private set
    var running = false
    var scheduled = false

    fun request(kind: RecordRefreshKind) {
        pending = if (pending == RecordRefreshKind.ALL) RecordRefreshKind.ALL else kind
    }

    fun take(): RecordRefreshKind? = pending.also { pending = null }
}
