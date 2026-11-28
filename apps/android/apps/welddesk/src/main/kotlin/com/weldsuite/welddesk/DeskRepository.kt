package com.weldsuite.welddesk

import android.content.Context
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.weldsuite.api.welddesk.apis.DefaultApi
import org.weldsuite.api.welddesk.models.DeskConversationDetail
import org.weldsuite.api.welddesk.models.DeskManageInput
import org.weldsuite.api.welddesk.models.DeskMessageAttachment
import org.weldsuite.api.welddesk.models.DeskReplyInput
import org.weldsuite.api.welddesk.models.DeskUploadedAttachmentResponse
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.realtime.realtimeBase
import org.weldsuite.core.server.ConfigResult
import org.weldsuite.core.server.ServerConfigLoader
import org.weldsuite.core.storage.PreferencesStore
import retrofit2.Response
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Path
import org.weldsuite.api.welddesk.models.DeskConversation as ApiConversation
import org.weldsuite.api.welddesk.models.DeskMessage as ApiMessage

/**
 * The upload of a reply's file: `multipart/form-data`, which the OpenAPI
 * contract can't describe (see `welddesk.yaml`), so it's declared here and
 * sent through the same API client (token, `X-Weld-App`, `X-Weld-Workspace`).
 */
internal interface AttachmentUploadApi {
    @Multipart
    @POST("api/desk/conversations/{id}/attachments")
    suspend fun upload(@Path("id") id: String, @Part file: MultipartBody.Part): Response<DeskUploadedAttachmentResponse>
}

/** A file the agent picked, read into memory (at most 10 MB). */
class PickedFile(val name: String, val contentType: String, val bytes: ByteArray)

/**
 * WeldDesk's calls. The generated API types are mapped to the app's own
 * models here and nowhere else, so a rename in the generated code stays in
 * this file.
 */
class DeskRepository(private val env: AppEnvironment, context: Context) {
    private val appContext = context.applicationContext
    private val api: DefaultApi get() = env.api.create()

    private val membersLock = Mutex()
    /** The roster, kept for the signed-in person in one workspace: members rarely change. */
    private var roster: Pair<String, List<Member>>? = null
    private var roomBase: String? = null

    suspend fun inbox(request: InboxRequest, cursor: String?): InboxPage {
        val page = apiCall {
            api.listDeskConversations(
                state = request.state,
                assigneeId = request.assigneeId,
                unassigned = request.unassigned,
                q = request.q,
                sort = request.sort,
                cursor = cursor,
                limit = DeskLogic.PAGE_SIZE,
            )
        }
        return InboxPage(page.data.map(::conversation), page.pagination.hasMore, page.pagination.cursor)
    }

    suspend fun conversation(id: String): ConversationDetail =
        detail(apiCall { api.getDeskConversation(id, include = "messages") }.data)

    /** A reply or a note, with files uploaded to the conversation first. */
    suspend fun reply(id: String, kind: MessageKind, body: String, attachments: List<Attachment>): ConversationChange {
        val input = DeskReplyInput(
            kind = if (kind == MessageKind.NOTE) DeskReplyInput.Kind.NOTE else DeskReplyInput.Kind.MESSAGE,
            body = body.trim().takeIf { it.isNotEmpty() },
            attachments = attachments.takeIf { it.isNotEmpty() }?.map(::attachmentInput),
        )
        val change = apiCall { api.replyToDeskConversation(id, input) }.data
        return ConversationChange(conversation(change.conversation), message(change.message))
    }

    suspend fun manage(id: String, action: ManageAction): ConversationChange {
        val input = when (action) {
            ManageAction.Close -> DeskManageInput(action = DeskManageInput.Action.CLOSE)
            ManageAction.Reopen -> DeskManageInput(action = DeskManageInput.Action.OPEN)
            // Without an assignee the server unassigns.
            is ManageAction.Assign -> DeskManageInput(action = DeskManageInput.Action.ASSIGN, assigneeId = action.assigneeId)
        }
        val change = apiCall { api.manageDeskConversation(id, input) }.data
        return ConversationChange(conversation(change.conversation), message(change.message))
    }

    /** Active internal members, for the assignee picker; loaded once per person and workspace unless [force]. */
    suspend fun members(force: Boolean = false): List<Member> {
        membersLock.withLock {
            val key = rosterKey()
            val cached = roster?.takeIf { !force && it.first == key }
            if (cached != null) return cached.second
            val list = apiCall { api.listTeamMembers(memberType = "INTERNAL", status = "ACTIVE", limit = 100) }.data
                .mapNotNull { DeskLogic.member(it.userId, it.name, it.email, it.picture) }
            roster = key to list
            return list
        }
    }

    /** The roster already loaded for this person and workspace, if any. */
    fun cachedMembers(): List<Member>? = roster?.takeIf { it.first == rosterKey() }?.second

    suspend fun upload(conversationId: String, file: PickedFile): Attachment {
        val part = MultipartBody.Part.createFormData(
            "file",
            file.name,
            file.bytes.toRequestBody(file.contentType.toMediaTypeOrNull()),
        )
        val uploaded = apiCall { env.api.create<AttachmentUploadApi>().upload(conversationId, part) }.data
        return attachment(uploaded) ?: throw org.weldsuite.core.api.ApiException(201, null, "No URL")
    }

    /**
     * The realtime service's base URL (the server's `realtimeUrl`), for a
     * conversation's room. The core keeps it to itself, so it's read from
     * the server's `/config.json` (cached on the phone) once.
     */
    suspend fun realtimeRoomBase(): String {
        roomBase?.let { return it }
        val loader = ServerConfigLoader(env.http, PreferencesStore(appContext))
        val configured = (loader.load(env.serverOrigin) as? ConfigResult.Loaded)?.config?.realtimeUrl
        return realtimeBase(configured, env.serverOrigin).also { roomBase = it }
    }

    /** A picked photo or document, read from its content URI. */
    suspend fun read(uri: android.net.Uri, fallbackName: String): ReadResult = Attachments.read(appContext, uri, fallbackName)

    /** Forget the roster (sign-out, another workspace). */
    fun clear() {
        roster = null
    }

    private fun rosterKey(): String {
        val session = env.session?.snapshot?.value
        return "${session?.person?.id.orEmpty()}:${session?.activeWorkspaceId.orEmpty()}"
    }

    companion object {
        fun conversation(item: ApiConversation): Conversation = Conversation(
            id = item.id,
            number = item.conversationNumber,
            title = item.title,
            state = ConversationState.of(item.state),
            channel = DeskChannel.of(item.channel),
            channelValue = item.channel,
            visitorId = item.visitorId,
            name = item.name,
            email = item.email,
            assigneeId = item.assigneeId,
            waitingSince = WeldDate.parse(item.waitingSince),
            lastMessageAt = WeldDate.parse(item.lastMessageAt),
            updatedAt = WeldDate.parse(item.updatedAt),
            lastMessagePreview = item.lastMessagePreview,
        )

        fun detail(item: DeskConversationDetail): ConversationDetail = ConversationDetail(
            conversation = Conversation(
                id = item.id,
                number = item.conversationNumber,
                title = item.title,
                state = ConversationState.of(item.state),
                channel = DeskChannel.of(item.channel),
                channelValue = item.channel,
                visitorId = item.visitorId,
                name = item.name,
                email = item.email,
                assigneeId = item.assigneeId,
                waitingSince = WeldDate.parse(item.waitingSince),
                lastMessageAt = WeldDate.parse(item.lastMessageAt),
                updatedAt = WeldDate.parse(item.updatedAt),
                lastMessagePreview = item.lastMessagePreview,
            ),
            messages = item.messages.map(::message),
        )

        fun message(item: ApiMessage): Message = Message(
            id = item.id,
            createdAt = WeldDate.parse(item.createdAt),
            conversationId = item.conversationId,
            kind = MessageKind.of(item.kind),
            body = item.body,
            authorType = AuthorType.of(item.authorType),
            authorId = item.authorId,
            attachments = item.attachments.orEmpty().mapNotNull(::attachment),
            eventType = item.metadata?.eventType,
            rating = item.metadata?.rating,
        )

        /** An attachment without a URL can't be shown or opened, so it's left out. */
        fun attachment(item: DeskMessageAttachment): Attachment? {
            val url = item.url?.takeIf { it.isNotBlank() } ?: return null
            return Attachment(item.name, url, item.contentType, item.filesize, item.width, item.height)
        }

        private fun attachmentInput(item: Attachment) = DeskMessageAttachment(
            name = item.name,
            url = item.url,
            contentType = item.contentType,
            filesize = item.size ?: 0,
            width = item.width,
            height = item.height,
        )

        /** A `desk_message` hub event's record, when it is one. */
        fun messageFromEvent(data: JsonElement): Message? =
            runCatching { message(WeldJson.decodeFromJsonElement(ApiMessage.serializer(), data)) }.getOrNull()

        /** A `desk_conversation` hub event's record, when it is one. */
        fun conversationFromEvent(data: JsonElement): Conversation? =
            runCatching { conversation(WeldJson.decodeFromJsonElement(ApiConversation.serializer(), data)) }.getOrNull()
    }
}
