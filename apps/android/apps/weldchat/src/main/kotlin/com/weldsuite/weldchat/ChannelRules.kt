package com.weldsuite.weldchat

import com.weldsuite.weldchat.calls.ActiveChannelCall
import com.weldsuite.weldchat.calls.CallPeer
import com.weldsuite.weldchat.media.ViewerImage

// The rules of the conversation screens, without the screens: who the
// mention picker offers, what a header says, who may rename or leave a
// channel, which call the header joins. Pure, so ChannelRulesTest covers
// them. The same rules as the iOS app's Channel/ChannelRules.swift.

/** What kind of conversation a screen shows, from the channel's `type`. */
enum class ConversationKind {
    CHANNEL,
    PRIVATE_CHANNEL,
    DM,
    RECORD,
    ;

    companion object {
        fun of(type: String?): ConversationKind = when (type) {
            "dm" -> DM
            "entity" -> RECORD
            "private" -> PRIVATE_CHANNEL
            else -> CHANNEL
        }
    }
}

/** Someone the mention picker offers: an agent in the channel, or a person. */
data class MentionCandidate(
    val userId: String,
    val name: String,
    val email: String? = null,
    val picture: String? = null,
    val isAgent: Boolean = false,
    val agentIcon: String? = null,
)

/** What the caller may do in a channel's details, from their role in it. */
data class ChannelPermissions(val isOwner: Boolean, val canManage: Boolean, val canLeave: Boolean) {
    val showActions: Boolean get() = canManage || canLeave || isOwner
}

object ChannelRules {
    /** The mention picker shows at most this many agents, then this many people. */
    const val MENTION_AGENT_LIMIT = 5
    const val MENTION_PEOPLE_LIMIT = 8

    /** How long a jumped-to message stays tinted. */
    const val JUMP_FLASH_MS = 1_800L

    /**
     * The channel's agents first, then the workspace's people; both matched
     * on name or e-mail, case-insensitively. An empty query matches everyone.
     */
    fun mentionCandidates(query: String, agents: List<ChannelMemberInfo>, people: List<TeamMember>): List<MentionCandidate> {
        val needle = query.lowercase()
        fun matches(name: String?, email: String?): Boolean =
            needle.isEmpty() || name?.lowercase()?.contains(needle) == true || email?.lowercase()?.contains(needle) == true
        val agentRows = agents
            .filter { it.isAgent && it.name != null && matches(it.name, null) }
            .take(MENTION_AGENT_LIMIT)
            .map { MentionCandidate(it.userId, it.name.orEmpty(), isAgent = true, agentIcon = it.agentIcon) }
        val peopleRows = people
            .filter { matches(it.name, it.email) }
            .take(MENTION_PEOPLE_LIMIT)
            .map { MentionCandidate(it.userId, it.displayName, it.email, it.picture) }
        return agentRows + peopleRows
    }

    /** Copy is offered for a message with text, not for one that is only a file or a voice note. */
    fun canCopy(message: ChatMessage): Boolean = MentionText.stripFileTokens(message.content).isNotBlank()

    /** The text that is copied: mentions as `@Name`, inline files dropped. */
    fun copyText(message: ChatMessage, names: Map<String, String>): String = MentionText.plainText(message.content, names).trim()

    /** Every photo of the conversation, oldest first, for the viewer. */
    fun images(messages: List<ChatMessage>): List<ViewerImage> {
        val seen = mutableSetOf<String>()
        return MessageLayout.chronological(messages).flatMap { message ->
            message.attachments.filter { it.isImage && seen.add(it.url) }.map { ViewerImage(it.url, message.authorName, message.createdAt) }
        }
    }

    /**
     * The header's name: a record chat goes by its record; the tapped row's
     * name covers the time until the channel loads.
     */
    fun displayName(channel: ChatChannel?, routeName: String?): String {
        if (channel != null) {
            val name = if (channel.isRecord) RecordChatRules.name(channel.entityDisplayName, channel.name) else channel.name
            if (name.isNotEmpty()) return name
        }
        return routeName.orEmpty()
    }

    /** The composer's placeholder; neutral until the name is known. */
    fun placeholder(kind: ConversationKind, name: String): UiText = when {
        kind == ConversationKind.DM || name.isEmpty() -> UiText.Res(R.string.weldchat_composer_message_dm)
        kind == ConversationKind.RECORD -> UiText.res(R.string.weldchat_record_chats_message_placeholder, name)
        else -> UiText.res(R.string.weldchat_composer_message_channel, name)
    }

    /** The empty conversation's first line. */
    fun welcome(kind: ConversationKind, name: String): UiText = when (kind) {
        ConversationKind.DM -> UiText.res(R.string.weldchat_channel_dm_conversation, name)
        ConversationKind.RECORD -> UiText.res(R.string.weldchat_record_chats_welcome, name)
        ConversationKind.CHANNEL, ConversationKind.PRIVATE_CHANNEL -> UiText.res(R.string.weldchat_channel_welcome, name)
    }

    /** Owners and admins rename and delete; members other than the owner may leave. */
    fun permissions(members: List<ChannelMemberInfo>, userId: String): ChannelPermissions {
        val role = members.firstOrNull { it.userId == userId }?.role
        val isOwner = role == "owner"
        return ChannelPermissions(isOwner = isOwner, canManage = role == "owner" || role == "admin", canLeave = role != null && !isOwner)
    }

    /** A call running here that the person is not in: the header offers "Join". */
    fun joinableCall(active: ActiveChannelCall?, inCallId: String?): ActiveChannelCall? =
        active?.takeIf { it.callId != inCallId }

    /** Who the call screen shows: the person of a DM, a record chat's name, `#channel`. */
    fun callPeer(kind: ConversationKind, name: String, picture: String?): CallPeer = when (kind) {
        ConversationKind.DM -> CallPeer(name = name.ifEmpty { null }, avatar = picture, isDirect = true)
        ConversationKind.RECORD -> CallPeer(name = name.ifEmpty { null })
        ConversationKind.CHANNEL, ConversationKind.PRIVATE_CHANNEL -> CallPeer(name = if (name.isEmpty()) null else "#$name")
    }

    /** The other person of a 1:1 DM; failing that, the roster member with the DM's name. */
    fun peerUserId(dm: DmConversation?, name: String, roster: List<TeamMember>): String? {
        if (dm != null) {
            if (dm.isGroup) return null
            dm.peerUserId?.let { return it }
        }
        if (name.isEmpty()) return null
        return roster.firstOrNull { it.name == name }?.userId
    }

    /**
     * The roster's membership status says whether the DM's person is around:
     * "Active now" for an active member, "Offline" otherwise, nothing when unknown.
     */
    fun presenceSubtitle(status: String?): Int? = when {
        status == null -> null
        status.uppercase() == "ACTIVE" -> R.string.weldchat_channel_active_now
        else -> R.string.weldchat_channel_offline
    }

    /** Another pin fits. */
    fun canPin(pinnedCount: Int): Boolean = pinnedCount < ChatLogic.PIN_LIMIT

    /** The people a channel invite offers: everyone in the workspace who isn't in it yet. */
    fun invitable(roster: List<TeamMember>, memberIds: Set<String>, search: String): List<TeamMember> {
        val needle = search.trim().lowercase()
        return roster.filter { person ->
            person.userId !in memberIds && (
                needle.isEmpty() ||
                    person.name?.lowercase()?.contains(needle) == true ||
                    person.email?.lowercase()?.contains(needle) == true
                )
        }
    }
}
