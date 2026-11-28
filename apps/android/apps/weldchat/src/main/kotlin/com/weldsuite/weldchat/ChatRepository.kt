package com.weldsuite.weldchat

import org.weldsuite.api.weldchat.apis.DefaultApi
import org.weldsuite.api.weldchat.models.AddMembersInput
import org.weldsuite.api.weldchat.models.Attachment
import org.weldsuite.api.weldchat.models.AttachmentInput
import org.weldsuite.api.weldchat.models.Bookmark
import org.weldsuite.api.weldchat.models.Channel
import org.weldsuite.api.weldchat.models.ChannelMember
import org.weldsuite.api.weldchat.models.CommonConcepts
import org.weldsuite.api.weldchat.models.CreateBookmarkInput
import org.weldsuite.api.weldchat.models.CreateChannelInput
import org.weldsuite.api.weldchat.models.CreateDmInput
import org.weldsuite.api.weldchat.models.CreateMessageInput
import org.weldsuite.api.weldchat.models.CreateSectionInput
import org.weldsuite.api.weldchat.models.DayHours
import org.weldsuite.api.weldchat.models.DmChannel
import org.weldsuite.api.weldchat.models.DmMember
import org.weldsuite.api.weldchat.models.DraftInput
import org.weldsuite.api.weldchat.models.MemberProfile
import org.weldsuite.api.weldchat.models.MemberStatus
import org.weldsuite.api.weldchat.models.MarkChatActivityReadInput
import org.weldsuite.api.weldchat.models.Message
import org.weldsuite.api.weldchat.models.ChatActivityItem
import org.weldsuite.api.weldchat.models.PinDmInput
import org.weldsuite.api.weldchat.models.PinInput
import org.weldsuite.api.weldchat.models.ReactionInput
import org.weldsuite.api.weldchat.models.SaveMemberNoteInput
import org.weldsuite.api.weldchat.models.SearchHit
import org.weldsuite.api.weldchat.models.UpdateChannelInput
import org.weldsuite.api.weldchat.models.UpdateMemberProfileInput
import org.weldsuite.api.weldchat.models.UpdateMembershipInput
import org.weldsuite.api.weldchat.models.UpdateMessageInput
import org.weldsuite.api.weldchat.models.RecordChat as ApiRecordChat
import org.weldsuite.api.weldchat.models.TeamMember as ApiTeamMember
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.api.apiCallNoContent
import retrofit2.Response
import java.time.Instant

/**
 * Every WeldChat endpoint except the calls (calls/CallApi.kt), through the
 * generated client (`apps/mobile-shared/openapi/weldchat.yaml`), with the
 * generated types mapped to the app's own models here and nowhere else.
 * Every call throws `ApiException` when it fails.
 *
 * @param dmTexts the names a DM falls back to, in the app's language.
 */
class ChatRepository(private val env: AppEnvironment, private val dmTexts: () -> DmTexts) {
    private val api: DefaultApi get() = env.api.create()

    /** The body and the status it came with (a 200 "already there" against a 201 "made"). */
    private suspend fun <T> withStatus(block: suspend () -> Response<T>): Pair<Int, T> {
        var status = 0
        val body = apiCall { block().also { status = it.code() } }
        return status to body
    }

    // Channels

    suspend fun listChannels(types: String?, limit: Int?, cursor: String? = null): Page<ChatChannel> {
        val body = apiCall { api.listChannels(types = types, limit = limit, cursor = cursor) }
        return Page(body.data.map { it.toChatChannel() }, body.pagination.cursor, body.pagination.hasMore)
    }

    suspend fun channel(id: String): ChatChannel = apiCall { api.getChannel(id) }.data.toChatChannel()

    /** A new channel; returns its id. A taken name answers 409. */
    suspend fun createChannel(name: String, isPrivate: Boolean, sectionId: String?, memberIds: List<String>): String {
        val input = CreateChannelInput(
            name = name,
            type = if (isPrivate) CreateChannelInput.Type.PRIVATE else CreateChannelInput.Type.PUBLIC,
            sectionId = sectionId,
            memberIds = memberIds.ifEmpty { null },
        )
        return apiCall { api.createChannel(input) }.data.id
    }

    suspend fun renameChannel(id: String, name: String) {
        apiCall { api.updateChannel(id, UpdateChannelInput(name)) }
    }

    suspend fun deleteChannel(id: String) = apiCallNoContent { api.deleteChannel(id) }

    suspend fun channelMembers(id: String): List<ChannelMemberInfo> = apiCall { api.listChannelMembers(id) }.data.map { it.toMember() }

    suspend fun addMembers(channelId: String, userIds: List<String>) {
        apiCall { api.addChannelMembers(channelId, AddMembersInput(userIds)) }
    }

    suspend fun leaveChannel(id: String) {
        apiCall { api.leaveChannel(id) }
    }

    suspend fun markRead(channelId: String) {
        apiCall { api.markChannelRead(channelId) }
    }

    // Memberships (mute, notification level)

    /** The caller's own row in a channel; null when they aren't in it. */
    suspend fun membership(channelId: String, userId: String): ChatMembership? =
        apiCall { api.listChannelMemberships(channelId = channelId, userId = userId) }.data.firstOrNull()?.let {
            ChatMembership(it.id, it.isMuted ?: false, NotificationLevel.of(it.notificationPreference))
        }

    suspend fun updateMembership(membershipId: String, isMuted: Boolean?, level: NotificationLevel?) {
        val input = UpdateMembershipInput(
            isMuted = isMuted,
            notificationPreference = level?.let { wanted -> UpdateMembershipInput.NotificationPreference.entries.firstOrNull { it.value == wanted.wire } },
        )
        apiCall { api.updateChannelMembership(membershipId, input) }
    }

    // Messages

    suspend fun messages(channelId: String, parentId: String? = null, cursor: String? = null, limit: Int? = null): Page<ChatMessage> {
        val body = apiCall { api.listMessages(channelId = channelId, parentId = parentId, cursor = cursor, limit = limit) }
        return Page(body.data.map { it.toChatMessage() }, body.pagination.cursor, body.pagination.hasMore)
    }

    suspend fun message(id: String): ChatMessage = apiCall { api.getMessage(id) }.data.toChatMessage()

    /** Send a message (a reply in the channel when [replyToId] is set, a thread reply with [parentId]); returns its id. */
    suspend fun send(
        channelId: String,
        body: String,
        parentId: String? = null,
        replyToId: String? = null,
        replyMention: Boolean? = null,
        attachments: List<ChatAttachment> = emptyList(),
    ): String {
        val input = CreateMessageInput(
            channelId = channelId,
            body = body,
            parentId = parentId,
            replyToId = replyToId,
            replyMention = replyMention,
            attachments = attachments.ifEmpty { null }?.map { AttachmentInput(url = it.url, id = it.id, fileName = it.fileName, fileSize = it.fileSize, mimeType = it.mimeType) },
        )
        return apiCall { api.createMessage(input) }.data.id
    }

    suspend fun editMessage(id: String, content: String) {
        apiCall { api.updateMessage(id, UpdateMessageInput(content)) }
    }

    suspend fun deleteMessage(id: String) = apiCallNoContent { api.deleteMessage(id) }

    suspend fun react(messageId: String, emoji: String, add: Boolean) {
        if (add) apiCall { api.addReaction(messageId, ReactionInput(emoji)) } else apiCall { api.removeReaction(messageId, emoji) }
    }

    /** Pin until [expiresAt] (null: for good); [notify] posts the channel's "pinned a message" notice. */
    suspend fun pin(messageId: String, expiresAt: Instant?, notify: Boolean) {
        apiCall { api.pinMessage(messageId, PinInput(expiresAt = expiresAt?.let { WeldDate.timestampString(it) }, notify = notify)) }
    }

    suspend fun unpin(messageId: String) {
        apiCall { api.unpinMessage(messageId) }
    }

    // Direct messages

    suspend fun listDms(currentUserId: String?): List<DmConversation> {
        val texts = dmTexts()
        return apiCall { api.listDms() }.data.map { it.toDm(currentUserId, texts) }
    }

    /** The DM with exactly these people, made when there is none. */
    suspend fun createDm(userIds: List<String>, currentUserId: String?): DmConversation =
        apiCall { api.createDm(CreateDmInput(userIds)) }.data.toDm(currentUserId, dmTexts())

    suspend fun setArchived(channelId: String, archived: Boolean) {
        if (archived) apiCall { api.archiveDm(channelId) } else apiCall { api.unarchiveDm(channelId) }
    }

    suspend fun pinDm(channelId: String, pinned: Boolean) {
        apiCall { api.pinDm(channelId, PinDmInput(pinned)) }
    }

    suspend fun leaveDm(channelId: String) = apiCallNoContent { api.leaveDm(channelId) }

    // Sections

    suspend fun listSections(): List<ChatSection> =
        apiCall { api.listSections(limit = 100) }.data.map { ChatSection(it.id, it.name, it.position ?: 0) }

    suspend fun createSection(name: String) {
        apiCall { api.createSection(CreateSectionInput(name)) }
    }

    // Search, drafts, saved, presence

    suspend fun search(text: String): List<SearchHitItem> = apiCall { api.searchMessages(q = text, limit = 50) }.data.messages.map { it.toSearchHit() }

    suspend fun listDrafts(channelId: String?): List<ChatDraft> =
        apiCall { api.listDrafts(channelId = channelId) }.data.map { ChatDraft(it.id, it.channelId, it.content, it.updatedAt) }

    /**
     * Save a channel's draft: a new one, or an update of [draftId]. Returns
     * the draft's id, or null when the server dropped it (empty content).
     */
    suspend fun saveDraft(draftId: String?, channelId: String, content: String, workspaceId: String?): String? {
        val input = DraftInput(workspaceId = workspaceId, channelId = channelId, content = content)
        if (draftId != null) {
            val result = apiCall { api.updateDraft(draftId, input) }.data
            return if (result.deleted == true) null else draftId
        }
        val result = apiCall { api.createDraft(input) }.data
        return if (result.deleted == true) null else result.id
    }

    suspend fun deleteDraft(id: String) = apiCallNoContent { api.deleteDraft(id) }

    suspend fun listBookmarks(limit: Int): List<ChatBookmark> = apiCall { api.listBookmarks(limit = limit) }.data.map { it.toBookmark() }

    /** Save a message for later. True when it was already saved. */
    suspend fun bookmark(messageId: String, channelId: String): Boolean {
        val (status, body) = withStatus { api.createBookmark(CreateBookmarkInput(messageId, channelId)) }
        return if (status == 201) false else body.data.alreadyExists ?: true
    }

    suspend fun deleteBookmark(id: String) = apiCallNoContent { api.deleteBookmark(id) }

    /** Everyone's presence that the server knows, by user id. */
    suspend fun presences(): Map<String, MemberPresence> = apiCall { api.listMemberStatuses() }.data.associate { it.userId to it.toPresence() }

    suspend fun presence(userId: String): MemberPresence = presences()[userId] ?: MemberPresence(PresenceStatus.OFFLINE)

    // Record chats

    suspend fun listRecordChats(type: String?, filter: String, search: String?, cursor: String?, limit: Int): Page<RecordChat> {
        val body = apiCall { api.listRecordChats(type = type, filter = filter, search = search, cursor = cursor, limit = limit) }
        return Page(body.data.map { it.toRecordChat() }, body.pagination.cursor, body.pagination.hasMore)
    }

    suspend fun recordChatSummary(): List<RecordChatTypeSummary> =
        apiCall { api.getRecordChatSummary() }.data.map { RecordChatTypeSummary(it.type, it.followed, it.unread, it.mentions) }

    suspend fun setFollowing(entityType: String, entityId: String, following: Boolean) {
        if (following) apiCall { api.followRecordChat(entityType, entityId) } else apiCallNoContent { api.unfollowRecordChat(entityType, entityId) }
    }

    /** A task's project, for its WeldFlow link. Null when unknown. */
    suspend fun recordProjectId(entityType: String, entityId: String): String? =
        runCatching { apiCall { api.getRecordDetail(entityType, entityId) }.data?.projectId }.getOrNull()

    // Team members

    suspend fun listTeamMembers(): List<TeamMember> = apiCall { api.listTeamMembers(memberType = "all", limit = 100) }.data.map { it.toTeamMember() }

    suspend fun memberProfile(userId: String): MemberProfileInfo = apiCall { api.getMemberProfile(userId) }.data.toProfile()

    /** Change one profile field; empty text clears it. */
    suspend fun updateProfile(userId: String, field: ProfileField, value: String): MemberProfileInfo {
        val input = when (field) {
            ProfileField.TITLE -> UpdateMemberProfileInput(title = value)
            ProfileField.BIO -> UpdateMemberProfileInput(bio = value)
            ProfileField.PHONE -> UpdateMemberProfileInput(phone = value)
            ProfileField.LOCATION -> UpdateMemberProfileInput(location = value)
            ProfileField.PRONOUNS -> UpdateMemberProfileInput(pronouns = value)
            ProfileField.HOURS_PER_WEEK -> UpdateMemberProfileInput(hoursPerWeek = MemberLogic.parseHours(value))
        }
        return apiCall { api.updateMemberProfile(userId, input) }.data.toProfile()
    }

    suspend fun memberCommon(userId: String): CommonConceptsInfo = apiCall { api.getMemberCommon(userId) }.data.toCommon()

    suspend fun memberActivity(userId: String): List<MemberActivityEntry> = apiCall { api.listMemberActivity(userId, limit = 50) }.data.map {
        MemberActivityEntry(it.id, it.action, it.entityType, it.entityId, it.description, it.createdAt)
    }

    /** The caller's private note about a member; empty when there is none. */
    suspend fun memberNote(userId: String): String = apiCall { api.getMemberNote(userId) }.data?.body.orEmpty()

    suspend fun saveMemberNote(userId: String, body: String) {
        apiCall { api.saveMemberNote(userId, SaveMemberNoteInput(body)) }
    }

    // Notifications (Activity)

    /** The Activity tab: the caller's chat activity (mentions, thread replies, missed calls), newest first, as the platform's. */
    suspend fun listActivity(limit: Int = 50): List<ActivityNotification> = apiCall { api.listChatActivity(limit = limit) }.data.map { it.toActivity() }

    /** The Activity badge: unread mentions, thread replies and missed calls, as the platform's (not other apps' notifications). */
    suspend fun unreadActivityCount(): Int = apiCall { api.getChatActivityUnreadCount() }.data.count

    /** Marks every activity item read (other apps' notifications stay unread). */
    suspend fun markAllActivityRead() {
        apiCallNoContent { api.markChatActivityRead(MarkChatActivityReadInput()) }
    }

    /** Marks one activity item read. */
    suspend fun markActivityRead(id: String) {
        apiCallNoContent { api.markChatActivityRead(MarkChatActivityReadInput(notificationId = id)) }
    }

}

// Mapping: the generated types to the app's, pure (ChatRepositoryTest).

internal fun Channel.toChatChannel() = ChatChannel(
    id = id,
    name = name,
    type = type,
    description = description,
    topic = topic,
    isArchived = isArchived ?: false,
    threadsEnabled = threadsEnabled ?: true,
    memberCount = memberCount,
    lastMessageAt = lastMessageAt,
    lastMessagePreview = lastMessagePreview,
    sectionId = sectionId,
    entityType = entityType,
    entityId = entityId,
    entityDisplayName = entityDisplayName,
    isMuted = isMuted ?: false,
    lastReadAt = lastReadAt,
    hasReadState = unreadMentionCount != null,
    unreadMentionCount = unreadMentionCount ?: 0,
    pinnedBy = metadata?.pinnedBy.orEmpty(),
    members = members.orEmpty().map { it.toMember() },
)

internal fun ChannelMember.toMember() = ChannelMemberInfo(
    id = id,
    userId = userId,
    memberType = memberType ?: "user",
    role = role,
    isMuted = isMuted ?: false,
    name = name,
    email = email,
    picture = picture,
    agentIcon = agentIcon,
)

/** An attachment with an address; one without can't be shown. */
internal fun Attachment.toChatAttachment(): ChatAttachment? {
    val address = url?.takeIf { it.isNotEmpty() } ?: return null
    return ChatAttachment(
        id = id ?: address,
        fileName = fileName ?: address.substringAfterLast('/').substringBefore('?').ifEmpty { address },
        fileSize = fileSize ?: 0.0,
        mimeType = mimeType ?: "application/octet-stream",
        url = address,
    )
}

internal fun Message.toChatMessage(): ChatMessage {
    val reply = metadata?.replyTo?.let { ref ->
        ReplyReference(
            messageId = ref.messageId,
            rootId = ref.rootId ?: ref.messageId,
            depth = ref.depth?.toInt() ?: 0,
            authorId = ref.authorId.orEmpty(),
            authorName = ref.authorName.orEmpty(),
            authorAvatar = ref.authorAvatar,
            content = ref.content.orEmpty(),
            hasAttachments = ref.hasAttachments ?: false,
        )
    }
    val visuals = metadata?.visuals.orEmpty().mapNotNull { visual ->
        visual.type?.takeIf { it in AgentVisuals.kinds }?.let { AgentVisualRef(it, visual.title.orEmpty()) }
    }
    return ChatMessage(
        id = id,
        channelId = channelId,
        authorId = authorId,
        authorName = authorName,
        authorAvatar = authorAvatar,
        authorType = authorType,
        content = content,
        type = type,
        parentId = parentId,
        threadReplyCount = threadReplyCount ?: 0,
        threadLastReplyAt = threadLastReplyAt,
        editedAt = editedAt,
        isPinned = isPinned ?: false,
        hasAttachments = hasAttachments ?: false,
        attachments = attachments.orEmpty().mapNotNull { it.toChatAttachment() },
        reactions = reactions.orEmpty(),
        replyTo = reply,
        visuals = visuals,
        createdAt = createdAt,
    )
}

internal fun DmMember.toPerson() = DmPerson(userId = userId, name = name, email = email, picture = picture)

internal fun DmChannel.toDm(currentUserId: String?, texts: DmTexts): DmConversation = DmLogic.conversation(
    id = id,
    type = type,
    storedName = name,
    otherMembers = otherMembers.orEmpty().map { it.toPerson() },
    lastMessageAt = lastMessageAt,
    lastReadAt = lastReadAt,
    pinnedBy = metadata?.pinnedBy.orEmpty(),
    currentUserId = currentUserId,
    isMuted = isMuted ?: false,
    lastMessagePreview = lastMessagePreview,
    isArchived = isArchived ?: false,
    texts = texts,
)

internal fun SearchHit.toSearchHit() = SearchHitItem(
    id = id,
    content = MentionText.stripFileTokens(content.orEmpty()),
    authorName = authorName,
    authorAvatar = authorAvatar,
    channelId = channelId,
    channelName = channel?.name,
    channelType = channel?.type,
    createdAt = createdAt,
    attachments = attachments.orEmpty().mapNotNull { it.toChatAttachment() },
)

internal fun Bookmark.toBookmark() = ChatBookmark(
    id = id,
    messageId = messageId,
    channelId = channelId,
    note = note,
    createdAt = createdAt,
    messageContent = messageContent,
    messageAuthorName = messageAuthorName,
    messageAuthorAvatar = messageAuthorAvatar,
    channelName = channelName,
    channelType = channelType,
)

internal fun MemberStatus.toPresence() = MemberPresence(
    status = PresenceStatus.of(status),
    statusText = statusText?.takeIf { it.isNotEmpty() },
    statusEmoji = statusEmoji?.takeIf { it.isNotEmpty() },
)

internal fun ApiRecordChat.toRecordChat() = RecordChat(
    id = id,
    name = name,
    entityType = entityType,
    entityId = entityId,
    entityDisplayName = entityDisplayName,
    lastMessageAt = lastMessageAt,
    lastMessagePreview = lastMessagePreview,
    isFollowing = isFollowing,
    isMuted = isMuted,
    lastReadAt = lastReadAt,
    unreadMentionCount = unreadMentionCount,
)

internal fun ApiTeamMember.toTeamMember() = TeamMember(
    id = id,
    userId = userId,
    name = name?.takeIf { it.isNotEmpty() },
    email = email,
    picture = picture,
    role = role,
    status = status,
    memberType = memberType,
)

private fun DayHours.toInfo() = DayHoursInfo(
    isOpen = isOpen ?: false,
    openTime = openTime,
    closeTime = closeTime,
    breaks = breaks.orEmpty().map { TimeRange(it.start.orEmpty(), it.end.orEmpty()) },
)

internal fun MemberProfile.toProfile(): MemberProfileInfo {
    val week = workingHours
    val hours = if (week == null) {
        emptyMap()
    } else {
        listOf(
            Weekday.MONDAY to week.monday,
            Weekday.TUESDAY to week.tuesday,
            Weekday.WEDNESDAY to week.wednesday,
            Weekday.THURSDAY to week.thursday,
            Weekday.FRIDAY to week.friday,
            Weekday.SATURDAY to week.saturday,
            Weekday.SUNDAY to week.sunday,
        ).mapNotNull { (day, value) -> value?.let { day to it.toInfo() } }.toMap()
    }
    return MemberProfileInfo(
        id = id,
        userId = userId,
        name = name?.takeIf { it.isNotEmpty() },
        email = email,
        picture = picture,
        role = role,
        status = status,
        title = title,
        bio = bio,
        phone = phone,
        location = location,
        pronouns = pronouns,
        links = links.orEmpty().mapNotNull { link -> link.url?.takeIf { it.isNotEmpty() }?.let { ProfileLinkItem(link.label ?: it, it) } },
        hoursPerWeek = hoursPerWeek,
        workingHours = hours,
        timezone = timezone,
        canEdit = canEdit,
    )
}

internal fun CommonConcepts.toCommon() = CommonConceptsInfo(
    channels = channels.map { CommonConceptsInfo.Channel(it.id, it.name, it.type, it.memberCount ?: 0) },
    projects = projects.map { CommonConceptsInfo.Project(it.id, it.name, it.status) },
    tasks = tasks.map { CommonConceptsInfo.Task(it.id, it.title, it.status.orEmpty(), it.role.orEmpty()) },
    // Only opportunities are surfaced from CRM, as on the platform.
    crm = crm.filter { it.kind == "opportunity" }.map { CommonConceptsInfo.Crm(it.id, it.kind, it.name, it.status) },
    helpdesk = helpdesk.map { CommonConceptsInfo.Helpdesk(it.id, it.kind, it.subject, it.status.orEmpty()) },
)

internal fun ChatActivityItem.toActivity() = ActivityNotification(
    id = id,
    title = title,
    body = body,
    category = "weldchat",
    notificationType = type,
    entityId = messageId,
    actionUrl = actionUrl,
    isRead = readAt != null,
    createdAt = createdAt,
    actorName = actorName,
    actorAvatar = actorAvatarUrl,
    actorId = actorId,
    channelId = channelId,
    channelName = channelName,
)
