package com.weldsuite.weldchat.ui.channel

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.weldsuite.weldchat.CallLog
import com.weldsuite.weldchat.CallLogEntry
import com.weldsuite.weldchat.ChannelMemberInfo
import com.weldsuite.weldchat.ChatAttachment
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatMessage
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationRules
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.MessageLayout
import com.weldsuite.weldchat.PinDuration
import com.weldsuite.weldchat.ReplyReference
import com.weldsuite.weldchat.media.ChatUpload
import com.weldsuite.weldchat.media.PendingFile
import com.weldsuite.weldchat.media.VoiceRecorder
import com.weldsuite.weldchat.realtime.ChatRoomSocket
import com.weldsuite.weldchat.realtime.RealtimeEndpoint
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import java.time.Instant
import java.util.UUID

/** The messages as drawn: oldest first, a call's end folded into its start's card. */
data class Timeline(val rows: List<ChatMessage>, val calls: Map<String, CallLogEntry>, val openCallId: String?)

/**
 * One open conversation (the iOS `ChannelModel`): the channel, its messages
 * (older pages on demand), the room socket, the composer's text, files,
 * reply and edit state, the draft saved as you type, and every action on a
 * message. A `ViewModel`, so it outlives the screen while a thread or a
 * profile is pushed on top of it; its state is Compose state.
 */
class ChannelModel(
    val channelId: String,
    val store: ChatStore,
    val env: AppEnvironment,
    val selfId: String,
    application: Application,
) : AndroidViewModel(application) {
    private val app: Application get() = getApplication()
    private val repository get() = store.repository

    var channel by mutableStateOf<ChatChannel?>(null)
        private set

    /** The DM as the DM list maps it: the header's name and picture. */
    var dm by mutableStateOf<DmConversation?>(null)
        private set
    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var hasOlder by mutableStateOf(false)
        private set
    var loadingOlder by mutableStateOf(false)
        private set
    var agents by mutableStateOf<List<ChannelMemberInfo>>(emptyList())
        private set

    /** Follow and mute of a record chat, shown before the channel reloads. */
    private var followOverride by mutableStateOf<Boolean?>(null)
    private var muteOverride by mutableStateOf<Boolean?>(null)

    var input by mutableStateOf(TextFieldValue(""))
        private set
    var pendingFiles by mutableStateOf<List<PendingFile>>(emptyList())
    var uploading by mutableStateOf(false)
        private set
    var replyTo by mutableStateOf<ReplyReference?>(null)
        private set
    var replyMention by mutableStateOf(true)
    var editing by mutableStateOf<ChatMessage?>(null)
        private set
    private var dismissedSuggestions by mutableStateOf<Set<String>>(emptySet())
    var mentionQuery by mutableStateOf<String?>(null)
        private set
    var pinnedIndex by mutableIntStateOf(0)
    var sendingVoiceDurationMs by mutableStateOf<Long?>(null)
        private set
    val recorder = VoiceRecorder(app)
    var room by mutableStateOf<ChatRoomSocket?>(null)
        private set

    private var olderCursor: String? = null
    private var olderLoaded = false
    private var pendingSends = mapOf<String, String?>()
    private val localPins = mutableSetOf<String>()
    private var started = false
    private var visible = false
    private var draftId: String? = null
    private var draftJob: Job? = null
    private var unsavedDraft: String? = null
    private var deletingDraft = false
    private var draftBeforeEdit = ""
    private var reloadJob: Job? = null

    // Derived

    val names: Map<String, String>
        get() {
            val names = store.memberNames.toMutableMap()
            agents.forEach { agent -> agent.name?.let { names[agent.userId] = it } }
            return names
        }

    val timeline: Timeline
        get() {
            val chronological = MessageLayout.chronological(messages)
            val log = CallLog.build(chronological)
            return Timeline(chronological.filter { it.id !in log.folded }, log.entries, log.openId)
        }

    val pinned: List<ChatMessage> get() = MessageLayout.chronological(messages).filter { it.isPinned && !it.pending }

    val canSend: Boolean get() = input.text.isNotBlank() || pendingFiles.isNotEmpty()

    val isRecording: Boolean get() = recorder.isRecording || sendingVoiceDurationMs != null

    val showThreadSuggestion: Boolean
        get() = ConversationRules.showThreadSuggestion(replyTo, editing != null, channel?.threadsEnabled, dismissedSuggestions)

    /** A record chat's follow state: a membership row in the loaded channel. */
    val following: Boolean?
        get() {
            val loaded = channel ?: return null
            return followOverride ?: loaded.members.any { it.userId == selfId }
        }

    val recordMuted: Boolean get() = muteOverride ?: channel?.members?.firstOrNull { it.userId == selfId }?.isMuted ?: false

    // Lifecycle

    /**
     * The screen is on: load everything the first time, refresh on a return,
     * and (re)connect the room. The loads run on the model's own scope, so a
     * thread pushed on top doesn't cut them short.
     */
    fun start() {
        visible = true
        viewModelScope.launch {
            if (!started) {
                started = true
                loadDraft()
                val channelLoad = async { loadChannel() }
                val messageLoad = async { loadMessages() }
                channelLoad.await()
                messageLoad.await()
                loadAgents()
            } else {
                loadMessages()
            }
            val current = room ?: ChatRoomSocket(env, RealtimeEndpoint.base(env), channelId, selfId).also { socket ->
                socket.onChange = ::scheduleReload
                room = socket
            }
            if (visible) current.start()
        }
    }

    /** The screen is off: the room closes until [start]. */
    fun stop() {
        visible = false
        room?.stop()
    }

    override fun onCleared() {
        room?.stop()
        if (recorder.isRecording) recorder.cancel()
        // A draft typed in the last moment is still saved.
        val text = unsavedDraft
        if (text != null && editing == null) {
            val id = draftId
            env.scope.launch { quietly { repository.saveDraft(id, channelId, text, store.workspaceId) } }
        }
    }

    private fun scheduleReload() {
        reloadJob?.cancel()
        reloadJob = viewModelScope.launch {
            delay(ConversationRules.ROOM_RELOAD_DELAY_MS)
            loadMessages()
        }
    }

    // Loading

    suspend fun loadChannel() {
        try {
            var loaded = repository.channel(channelId)
            if (loaded.isDm) {
                val listed = quietly { repository.listDms(store.currentUserId) }?.firstOrNull { it.id == channelId }
                if (listed != null) {
                    dm = listed
                    loaded = loaded.copy(name = listed.name)
                }
            }
            channel = loaded
            followOverride = null
            muteOverride = null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The header keeps the name the list gave.
        }
    }

    private suspend fun loadAgents() {
        val members = quietly { repository.channelMembers(channelId) } ?: return
        agents = members.filter { it.isAgent && it.name != null }
    }

    suspend fun loadMessages() {
        try {
            val page = repository.messages(channelId)
            val fetched = ConversationRules.withLocalPins(page.items, localPins)
            pendingSends = ConversationRules.unsettled(pendingSends, fetched.map { it.id }.toSet())
            val pending = messages.filter { it.pending && pendingSends.containsKey(it.id) }
            messages = MessageLayout.merge(messages, fetched, pending)
            if (!olderLoaded) {
                olderCursor = page.cursor
                hasOlder = page.hasMore
            }
            // Viewing it reads it.
            viewModelScope.launch { quietly { repository.markRead(channelId) } }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Keep what is on screen.
        }
        loading = false
    }

    suspend fun loadOlder() {
        val cursor = olderCursor
        if (!hasOlder || cursor == null || loadingOlder) return
        loadingOlder = true
        try {
            val page = quietly { repository.messages(channelId, cursor = cursor) } ?: return
            olderLoaded = true
            messages = ConversationRules.prependOlder(messages, page.items)
            olderCursor = page.cursor
            hasOlder = page.hasMore
        } finally {
            loadingOlder = false
        }
    }

    // Drafts

    private suspend fun loadDraft() {
        val draft = quietly { repository.listDrafts(channelId) }?.firstOrNull() ?: return
        if (draft.content.isEmpty()) return
        draftId = draft.id
        setInput(draft.content)
    }

    /** The composer's text changed by typing (or its cursor moved). */
    fun onInputChange(value: TextFieldValue) {
        val changed = value.text != input.text
        input = value
        if (!changed) return
        val text = value.text
        if (text.isNotEmpty()) room?.keystroke()
        if (editing == null) {
            if (text.isBlank()) {
                viewModelScope.launch { clearDraft() }
            } else {
                saveDraft(text)
            }
        }
        mentionQuery = MentionText.mentionQuery(text)
    }

    private fun setInput(text: String) {
        input = TextFieldValue(text, TextRange(text.length))
    }

    /** Saved a moment after the last keystroke. */
    private fun saveDraft(text: String) {
        draftJob?.cancel()
        unsavedDraft = text
        draftJob = viewModelScope.launch {
            delay(ConversationRules.DRAFT_SAVE_DELAY_MS)
            if (deletingDraft) return@launch
            try {
                val id = repository.saveDraft(draftId, channelId, text, store.workspaceId)
                unsavedDraft = null
                if (deletingDraft) {
                    // Cleared while this was being made: don't keep an orphan.
                    if (id != null) env.scope.launch { quietly { repository.deleteDraft(id) } }
                } else {
                    draftId = id
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best effort.
            }
        }
    }

    private suspend fun clearDraft() {
        draftJob?.cancel()
        unsavedDraft = null
        deletingDraft = true
        try {
            val id = draftId ?: return
            draftId = null
            quietly { repository.deleteDraft(id) }
        } finally {
            deletingDraft = false
        }
    }

    // Composer

    fun insertMention(userId: String) {
        setInput(MentionText.insertMention(input.text, userId))
        mentionQuery = null
    }

    fun startReply(message: ChatMessage) {
        replyTo = ConversationRules.replyReference(message)
        replyMention = true
    }

    fun cancelReply() {
        replyTo = null
    }

    fun startEdit(message: ChatMessage) {
        if (editing == null) draftBeforeEdit = input.text
        editing = message
        setInput(message.content)
    }

    fun cancelEdit() {
        editing = null
        setInput(draftBeforeEdit)
        draftBeforeEdit = ""
    }

    fun dismissThreadSuggestion() {
        val reply = replyTo ?: return
        dismissedSuggestions = dismissedSuggestions + reply.rootId
    }

    /** A long reply chain moves into a thread on its root, the text carried over. */
    fun continueInThread(): Pair<String, String>? {
        val reply = replyTo ?: return null
        val draft = input.text
        replyTo = null
        setInput("")
        mentionQuery = null
        viewModelScope.launch { clearDraft() }
        return reply.rootId to draft
    }

    enum class SendOutcome { SENT, AI_UNAVAILABLE, FAILED, EDITED, EDIT_FAILED }

    /**
     * Send what the composer holds (or save the edit). Shown at once; the
     * text, reply and files come back when it fails. [you] names the caller
     * when the roster doesn't know them yet.
     */
    suspend fun send(you: String): SendOutcome {
        editing?.let { return submitEdit(it) }
        val text = input.text.trim()
        if ((text.isEmpty() && pendingFiles.isEmpty()) || uploading) return SendOutcome.SENT
        if (ConversationRules.isAskCommand(text)) return SendOutcome.AI_UNAVAILABLE
        val files = pendingFiles
        val reply = replyTo
        val mention = replyMention
        setInput("")
        mentionQuery = null
        replyTo = null
        pendingFiles = emptyList()
        viewModelScope.launch { clearDraft() }
        room?.sent()

        val tempId = ConversationRules.PENDING_PREFIX + UUID.randomUUID()
        val ownLast = messages.lastOrNull { it.authorId == selfId && !it.pending }
        val authorName = names[selfId]?.takeIf { it.isNotEmpty() } ?: ownLast?.authorName?.takeIf { it.isNotEmpty() } ?: you
        val optimistic = ConversationRules.optimisticMessage(
            tempId = tempId,
            channelId = channelId,
            authorId = selfId,
            authorName = authorName,
            authorAvatar = ownLast?.authorAvatar,
            text = text,
            hasFiles = files.isNotEmpty(),
            reply = reply,
            createdAt = WeldDate.timestampString(Instant.now()),
        )
        pendingSends = pendingSends + (tempId to null)
        messages = messages + optimistic
        return try {
            val attachments = upload(files)
            val id = repository.send(
                channelId = channelId,
                body = text,
                replyToId = reply?.messageId,
                replyMention = if (reply == null) null else mention,
                attachments = attachments,
            )
            pendingSends = pendingSends + (tempId to id)
            loadMessages()
            // Posting in a record chat follows it.
            if (channel?.isRecord == true && following == false) loadChannel()
            SendOutcome.SENT
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            pendingSends = pendingSends - tempId
            messages = messages.filter { it.id != tempId }
            if (input.text.isEmpty()) setInput(text)
            if (replyTo == null) replyTo = reply
            if (pendingFiles.isEmpty()) pendingFiles = files
            SendOutcome.FAILED
        }
    }

    /** Every file, uploaded; the ones that fail are dropped, and all failing fails the send. */
    private suspend fun upload(files: List<PendingFile>): List<ChatAttachment> {
        if (files.isEmpty()) return emptyList()
        uploading = true
        try {
            val uploaded = files.mapNotNull { file -> quietly { ChatUpload.upload(app, env, file, channelId) } }
            if (uploaded.isEmpty()) throw ApiException(0, null, "Upload failed")
            return uploaded
        } finally {
            uploading = false
        }
    }

    private suspend fun submitEdit(message: ChatMessage): SendOutcome {
        val text = input.text.trim()
        if (text.isEmpty()) return SendOutcome.EDITED
        messages = ConversationRules.withEdit(messages, message.id, text, WeldDate.timestampString(Instant.now()))
        editing = null
        setInput(draftBeforeEdit)
        draftBeforeEdit = ""
        return try {
            repository.editMessage(message.id, text)
            loadMessages()
            SendOutcome.EDITED
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            loadMessages()
            SendOutcome.EDIT_FAILED
        }
    }

    enum class VoiceOutcome { SENT, TOO_SHORT, FAILED }

    fun startRecording(): VoiceRecorder.StartResult = recorder.start(viewModelScope)

    fun cancelRecording() {
        recorder.cancel()
    }

    suspend fun sendVoice(): VoiceOutcome {
        if (recorder.durationMs < ChatLogic.MIN_VOICE_MESSAGE_MS) {
            recorder.cancel()
            return VoiceOutcome.TOO_SHORT
        }
        sendingVoiceDurationMs = recorder.durationMs
        try {
            val recording = recorder.stop() ?: return VoiceOutcome.FAILED
            if (recording.isTooShort) return VoiceOutcome.TOO_SHORT
            val uploaded = ChatUpload.upload(app, env, recording.file, channelId)
            repository.send(channelId = channelId, body = "", attachments = listOf(uploaded))
            room?.sent()
            loadMessages()
            return VoiceOutcome.SENT
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return VoiceOutcome.FAILED
        } finally {
            sendingVoiceDurationMs = null
        }
    }

    // Message actions

    /** Shown at once, then the server's version. False when it failed. */
    suspend fun toggleReaction(message: ChatMessage, emoji: String): Boolean {
        val has = ConversationRules.hasReacted(message, emoji, selfId)
        messages = ConversationRules.withReaction(messages, message.id, emoji, selfId, !has)
        val ok = attempt { repository.react(message.id, emoji, !has) }
        loadMessages()
        return ok
    }

    suspend fun pin(message: ChatMessage, duration: PinDuration, notify: Boolean): Boolean {
        localPins.add(message.id)
        messages = ConversationRules.withPinned(messages, message.id, true)
        val ok = attempt { repository.pin(message.id, duration.expiresAt(), notify) }
        if (!ok) localPins.remove(message.id)
        loadMessages()
        return ok
    }

    suspend fun unpin(message: ChatMessage) {
        localPins.remove(message.id)
        messages = ConversationRules.withPinned(messages, message.id, false)
        attempt { repository.unpin(message.id) }
        loadMessages()
    }

    suspend fun delete(message: ChatMessage): Boolean {
        messages = messages.filter { it.id != message.id }
        val ok = attempt { repository.deleteMessage(message.id) }
        loadMessages()
        return ok
    }

    suspend fun unarchive(): Boolean = attempt { repository.setArchived(channelId, false) }

    // Record chats

    suspend fun toggleFollow(): Boolean {
        val isFollowing = following ?: return true
        val loaded = channel ?: return true
        val type = loaded.entityType ?: return true
        val id = loaded.entityId ?: return true
        val next = !isFollowing
        followOverride = next
        muteOverride = next && recordMuted
        store.forgetMembership(channelId)
        return if (attempt { repository.setFollowing(type, id, next) }) {
            loadChannel()
            true
        } else {
            followOverride = null
            muteOverride = null
            false
        }
    }

    suspend fun toggleRecordMute(): Boolean {
        if (following != true) return true
        val next = !recordMuted
        muteOverride = next
        return if (attempt { store.updateMembership(channelId, isMuted = next) }) {
            true
        } else {
            muteOverride = !next
            false
        }
    }

    /** Run a call; false when it failed (cancellation still cancels). */
    private suspend fun attempt(block: suspend () -> Unit): Boolean = try {
        block()
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        false
    }

    private suspend fun <T> quietly(block: suspend () -> T): T? = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }
}
