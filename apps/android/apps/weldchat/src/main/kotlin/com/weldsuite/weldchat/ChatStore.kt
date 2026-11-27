package com.weldsuite.weldchat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.realtime.RealtimeEvent
import java.time.Instant

/**
 * The lists Home, the DM list and the Activity badge share, so switching
 * tabs paints at once, and the caller's memberships (mute, notification
 * level). A screen's own data (messages, a profile) stays in the screen and
 * comes from [repository]. One per app process, like the iOS `ChatStore`;
 * its state is Compose state, read on the main thread.
 */
class ChatStore(val env: AppEnvironment, val repository: ChatRepository) {
    var channels by mutableStateOf<List<ChatChannel>>(emptyList())
        private set
    var sections by mutableStateOf<List<ChatSection>>(emptyList())
        private set
    var dms by mutableStateOf<List<DmConversation>>(emptyList())
        private set
    var homeLoaded by mutableStateOf(false)
        private set
    var dmsLoaded by mutableStateOf(false)
        private set
    var savedCount by mutableStateOf<Int?>(null)
        private set
    var draftCount by mutableStateOf<Int?>(null)
        private set
    var activityUnread by mutableStateOf(0)
        private set

    /** The workspace roster: names for mentions, presence for DM headers. */
    var roster by mutableStateOf<List<TeamMember>>(emptyList())
        private set
    var recordSummary by mutableStateOf<List<RecordChatTypeSummary>?>(null)
        private set
    var recordRows by mutableStateOf<Map<String, List<RecordChat>>>(emptyMap())
        private set

    /** The signed-in person's WeldSuite user id. */
    var currentUserId: String? = null
        private set

    /** The active workspace's id (drafts carry it). */
    var workspaceId: String? = null
        private set

    private val memberships = mutableMapOf<String, ChatMembership>()
    private val recordRefresh = RecordRefreshQueue()
    private var recordGeneration = 0
    private var personalEvents: Job? = null

    /** Forget another workspace's (or person's) lists the moment they change. */
    fun use(workspace: String, userId: String) {
        if (workspaceId == workspace && currentUserId == userId) return
        workspaceId = workspace
        currentUserId = userId
        channels = emptyList()
        sections = emptyList()
        dms = emptyList()
        homeLoaded = false
        dmsLoaded = false
        savedCount = null
        draftCount = null
        activityUnread = 0
        roster = emptyList()
        recordSummary = null
        recordRows = emptyMap()
        memberships.clear()
        recordGeneration++
    }

    /** User id → name, for mentions and typing. */
    val memberNames: Map<String, String> get() = roster.mapNotNull { member -> member.name?.let { member.userId to it } }.toMap()

    fun memberStatus(userId: String): String? = roster.firstOrNull { it.userId == userId }?.status

    // Shared lists

    /** Home's channels, sections and DMs. A failure keeps what was shown. */
    suspend fun loadHome() {
        val forWorkspace = workspaceId
        val me = currentUserId
        coroutineScope {
            val channelPage = async { quietly { repository.listChannels(types = "public,private", limit = 100) } }
            val sectionList = async { quietly { repository.listSections() } }
            val dmList = async { quietly { repository.listDms(me) } }
            val loadedChannels = channelPage.await()
            val loadedSections = sectionList.await()
            val loadedDms = dmList.await()
            if (workspaceId != forWorkspace) return@coroutineScope
            // DMs and record chats have their own lists.
            loadedChannels?.let { page -> channels = page.items.filter { !it.isDm && !it.isRecord } }
            loadedSections?.let { sections = it }
            loadedDms?.let {
                dms = it
                dmsLoaded = true
            }
            homeLoaded = true
        }
    }

    suspend fun loadDmList() {
        val forWorkspace = workspaceId
        val loaded = quietly { repository.listDms(currentUserId) } ?: return
        if (workspaceId != forWorkspace) return
        dms = loaded
        dmsLoaded = true
    }

    /** The counts on Home's Saved and Drafts tiles. Best effort. */
    suspend fun loadCounts() {
        quietly { repository.listBookmarks(ChatLogic.SAVED_CAP) }?.let { savedCount = it.size }
        quietly { repository.listDrafts(null) }?.let { draftCount = it.size }
    }

    suspend fun loadActivityUnread() {
        quietly { repository.unreadNotificationCount() }?.let { activityUnread = it }
    }

    fun updateActivityUnread(count: Int) {
        activityUnread = count.coerceAtLeast(0)
    }

    suspend fun loadRosterIfNeeded() {
        if (roster.isEmpty()) loadRoster()
    }

    suspend fun loadRoster() {
        quietly { repository.listTeamMembers() }?.let { roster = it }
    }

    /** A change made from a row's menu, shown before the server confirms it. */
    fun patchChannel(id: String, patch: ConversationPatch) {
        channels = channels.map { channel ->
            if (channel.id != id) return@map channel
            var next = channel
            patch.isMuted?.let { next = next.copy(isMuted = it) }
            if (patch.hasUnread == false) {
                next = next.copy(unreadMentionCount = 0, lastReadAt = WeldDate.timestampString(Instant.now()), hasReadState = true)
            }
            next
        }
    }

    fun patchDm(id: String, patch: ConversationPatch) {
        if (patch.archived == true) {
            removeDm(id)
            return
        }
        dms = dms.map { dm ->
            if (dm.id != id) return@map dm
            var next = dm
            patch.isMuted?.let { next = next.copy(isMuted = it) }
            patch.isPinned?.let { next = next.copy(isPinned = it) }
            patch.hasUnread?.let { next = next.copy(hasUnread = it) }
            next
        }
    }

    fun removeDm(id: String) {
        dms = dms.filter { it.id != id }
    }

    // Record chats on Home

    /** Reload the record chat groups; [immediate] skips the burst wait. */
    fun refreshRecordChats(kind: RecordRefreshKind, immediate: Boolean = false) {
        recordRefresh.request(kind)
        if (immediate) {
            env.scope.launch { runRecordRefresh() }
        } else if (!recordRefresh.scheduled) {
            recordRefresh.scheduled = true
            env.scope.launch {
                delay(400)
                recordRefresh.scheduled = false
                runRecordRefresh()
            }
        }
    }

    /** One load at a time; a request that comes in meanwhile runs after it. */
    private suspend fun runRecordRefresh() {
        if (recordRefresh.running) return
        while (true) {
            val kind = recordRefresh.take() ?: break
            recordRefresh.running = true
            try {
                loadRecordChats(kind)
            } finally {
                recordRefresh.running = false
            }
        }
    }

    /** ALL: the summary and every followed type. SUMMARY: the summary, then only the types whose counts moved. */
    private suspend fun loadRecordChats(kind: RecordRefreshKind) {
        val generation = recordGeneration
        val summary = quietly { repository.recordChatSummary() } ?: return
        val types = if (kind == RecordRefreshKind.ALL) RecordChatRules.types else RecordChatRules.changedSummaryTypes(recordSummary, summary)
        val loaded = mutableMapOf<String, List<RecordChat>>()
        for (type in types) {
            val counts = summary.firstOrNull { it.type == type }
            loaded[type] = if (counts == null || counts.followed <= 0) emptyList() else loadFollowed(type, counts)
        }
        if (generation != recordGeneration) return
        recordSummary = summary
        recordRows = recordRows + loaded
    }

    /** The followed chats of one type; more pages while the summary counts unread chats or mentions the rows don't hold yet. */
    private suspend fun loadFollowed(type: String, counts: RecordChatTypeSummary): List<RecordChat> {
        val pages = mutableListOf<List<RecordChat>>()
        var cursor: String? = null
        repeat(RecordChatRules.MAX_GROUP_PAGES) {
            val page = quietly { repository.listRecordChats(type, "following", null, cursor, 25) } ?: return RecordChatRules.uniqueRows(pages)
            pages.add(page.items)
            val next = page.cursor
            if (!page.hasMore || next == null || RecordChatRules.coversUnread(RecordChatRules.uniqueRows(pages), counts)) {
                return RecordChatRules.uniqueRows(pages)
            }
            cursor = next
        }
        return RecordChatRules.uniqueRows(pages)
    }

    fun patchRecordChat(id: String, patch: RecordChatPatch) {
        val next = RecordChatRules.patch(recordSummary, recordRows, id, patch, Instant.now())
        recordSummary = next.summary
        recordRows = next.rows
    }

    // Memberships (mute, notification level)

    fun cachedMembership(channelId: String): ChatMembership? = memberships[channelId]

    fun forgetMembership(channelId: String) {
        memberships.remove(channelId)
    }

    /** The caller's row in a channel, cached; null when they aren't in it. */
    suspend fun membership(channelId: String): ChatMembership? {
        memberships[channelId]?.let { return it }
        val userId = currentUserId ?: return null
        val found = repository.membership(channelId, userId)
        if (found != null) memberships[channelId] = found
        return found
    }

    /** Mute or the notification level, on the caller's own row (`channels:read` is enough). */
    suspend fun updateMembership(channelId: String, isMuted: Boolean? = null, level: NotificationLevel? = null) {
        val row = membership(channelId) ?: throw ApiException(404, null, null)
        repository.updateMembership(row.id, isMuted, level)
        memberships[channelId] = row.copy(
            isMuted = isMuted ?: row.isMuted,
            notificationPreference = level ?: row.notificationPreference,
        )
    }

    /** The 1:1 DM with [userId], made if there isn't one yet. */
    suspend fun ensureDm(userId: String): DmConversation {
        repository.listDms(currentUserId).firstOrNull { !it.isGroup && it.otherMembers.firstOrNull()?.userId == userId }?.let { return it }
        return repository.createDm(listOf(userId), currentUserId)
    }

    // The personal topics

    /**
     * `chat.user.<id>` (new channels and DMs, unread counts, calls) and
     * `notification.<id>` (in-app notifications): reload Home's lists, the
     * Activity badge and the record chat groups that moved. Once per person.
     */
    fun followPersonalEvents(userId: String) {
        personalEvents?.cancel()
        val realtime = env.realtime ?: return
        personalEvents = env.scope.launch {
            var pending: Job? = null
            realtime.events(listOf("chat.user.$userId", "notification.$userId")).collect { event ->
                if (event.topic.startsWith("notification.") && event.event != "created" && !event.isResync) return@collect
                when (personalRefresh(event)) {
                    RecordChatRules.Refresh.ALL -> refreshRecordChats(RecordRefreshKind.ALL)
                    RecordChatRules.Refresh.SUMMARY -> refreshRecordChats(RecordRefreshKind.SUMMARY)
                    RecordChatRules.Refresh.NONE -> Unit
                }
                // A busy chat sends an event per message: reload once per burst.
                pending?.cancel()
                pending = launch {
                    delay(300)
                    loadHome()
                    loadActivityUnread()
                }
            }
        }
    }

    fun stopPersonalEvents() {
        personalEvents?.cancel()
        personalEvents = null
    }

    private fun personalRefresh(event: RealtimeEvent): RecordChatRules.Refresh {
        val channelId = ((event.data as? JsonObject)?.get("channelId") as? JsonPrimitive)?.contentOrNull
        val records = recordRows.values.flatten().map { it.id }.toSet()
        val known = (channels.map { it.id } + dms.map { it.id }).toSet()
        return RecordChatRules.refresh(if (event.isResync) null else event.event, channelId, records, known)
    }

    /** A best-effort read: null when it failed (cancellation still cancels). */
    private suspend fun <T> quietly(block: suspend () -> T): T? = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }
}
