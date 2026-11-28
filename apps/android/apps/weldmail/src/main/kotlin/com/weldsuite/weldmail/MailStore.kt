package com.weldsuite.weldmail

import android.content.Context
import androidx.core.content.edit
import com.weldsuite.weldmail.offline.Connectivity
import com.weldsuite.weldmail.offline.FailureKind
import com.weldsuite.weldmail.offline.FlagPatch
import com.weldsuite.weldmail.offline.MailCache
import com.weldsuite.weldmail.offline.OutboxOp
import com.weldsuite.weldmail.offline.OutboxRules
import com.weldsuite.weldmail.offline.OutboxStore
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import java.io.File
import java.util.UUID

/** Which mailbox the inbox shows: every one at once, or one. */
sealed interface Mailbox {
    data object Unified : Mailbox

    data class Account(val id: String) : Mailbox

    /** The cache's key for it. */
    val key: String
        get() = when (this) {
            Unified -> "unified"
            is Account -> id
        }
}

/** The inbox as the screen shows it. */
data class InboxState(
    val messages: List<MailMessage> = emptyList(),
    /** Where the next page starts; null once everything is loaded. */
    val cursor: String? = null,
    /** False while the list is an offline-cache paint whose place in the mailbox is unknown. */
    val cursorKnown: Boolean = false,
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val error: Throwable? = null,
)

/**
 * The mailboxes, the folder on screen, its messages and every change made to
 * them, for the active workspace (the Expo app's MailContext, inbox and
 * `useMailOutbox` in one): the lists paint from the offline cache first and
 * are then reloaded; a change shows at once, waits in the outbox, and goes to
 * the server now or when the phone is back online.
 */
class MailStore(
    context: Context,
    private val env: AppEnvironment,
    val repository: MailRepository,
    val connectivity: Connectivity,
) {
    private val prefs = context.getSharedPreferences("weldmail.store", Context.MODE_PRIVATE)
    val cache = MailCache(File(context.filesDir, "weldmail-cache"))
    private val outbox = OutboxStore(File(context.filesDir, "weldmail-outbox"))

    private var workspace: String? = null

    private val accountsState = MutableStateFlow<List<MailAccount>>(emptyList())
    private val accountsLoadedState = MutableStateFlow(false)
    private val mailboxState = MutableStateFlow<Mailbox>(Mailbox.Unified)
    private val labelState = MutableStateFlow(SystemLabel.INBOX.slug)
    private val labelsState = MutableStateFlow(LabelState())
    private val inboxState = MutableStateFlow(InboxState())
    private val pendingState = MutableStateFlow(0)
    private val expectedState = MutableStateFlow<String?>(null)

    /** The active workspace's mailboxes first, then those of the person's other workspaces. */
    val accounts: StateFlow<List<MailAccount>> = accountsState.asStateFlow()
    val accountsLoaded: StateFlow<Boolean> = accountsLoadedState.asStateFlow()
    val mailbox: StateFlow<Mailbox> = mailboxState.asStateFlow()

    /** The folder or label on screen: a system slug (`INBOX`) or a label's slug. */
    val label: StateFlow<String> = labelState.asStateFlow()
    val labels: StateFlow<LabelState> = labelsState.asStateFlow()
    val inbox: StateFlow<InboxState> = inboxState.asStateFlow()

    /** Changes waiting in the outbox. */
    val pending: StateFlow<Int> = pendingState.asStateFlow()

    /** The message a notification opened, until the inbox lists it. */
    val expected: StateFlow<String?> = expectedState.asStateFlow()

    /** The messages in the order the inbox shows them, for "archive and open the next". */
    @Volatile var visibleIds: List<String> = emptyList()

    /** Each list on screen this session, so going back to one paints at once. */
    private val snapshots = mutableMapOf<String, InboxState>()
    private var listJob: Job? = null
    private var listGeneration = 0

    private val scopeKey: String get() = "${mailboxState.value.key}::${labelState.value}"

    private val accountId: String? get() = (mailboxState.value as? Mailbox.Account)?.id

    /** The mailboxes mail can be sent from: those in the active workspace. */
    val sendableAccounts: List<MailAccount> get() = accountsState.value.filter { it.inActiveWorkspace }

    /** The person's own addresses, left out of a reply-all. */
    val ownAddresses: List<String> get() = accountsState.value.map { it.email }

    /** The selected mailbox, or null in the unified inbox. */
    val selectedAccount: MailAccount? get() = accountId?.let { id -> accountsState.value.firstOrNull { it.id == id } }

    // ---------------------------------------------------------------- workspace

    /** The active workspace changed (or the app opened in one): start over in it. */
    fun useWorkspace(id: String) {
        if (workspace == id) return
        workspace = id
        snapshots.clear()
        accountsState.value = emptyList()
        accountsLoadedState.value = false
        labelsState.value = LabelState()
        labelState.value = SystemLabel.INBOX.slug
        val saved = prefs.getString(selectionKey(id), null)
        mailboxState.value = if (saved == null || saved == UNIFIED) Mailbox.Unified else Mailbox.Account(saved)
        inboxState.value = InboxState()
        env.scope.launch {
            refreshPending()
            loadAccounts()
            reloadList()
            loadLabels()
            flush()
            migrateLocalPins()
        }
    }

    /** Sign-out: nothing of this person's mail stays on the phone. */
    fun clear() {
        workspace = null
        snapshots.clear()
        accountsState.value = emptyList()
        inboxState.value = InboxState()
        labelsState.value = LabelState()
        prefs.edit { clear() }
        env.scope.launch {
            cache.clearAll()
            outbox.clearAll()
            pendingState.value = 0
        }
    }

    private fun selectionKey(workspace: String) = "selection.$workspace"

    /** A mailbox of another workspace was picked: it opens once the app is in that workspace. */
    fun preselect(workspace: String, accountId: String) {
        prefs.edit { putString(selectionKey(workspace), accountId) }
    }

    // ---------------------------------------------------------------- mailboxes

    suspend fun loadAccounts() {
        val ws = workspace ?: return
        try {
            val own = repository.accounts()
            val others = repository.otherWorkspaceAccounts(ws)
            if (workspace != ws) return
            val all = own + others.filter { other -> own.none { it.id == other.id } }
            accountsState.value = all
            cache.putAccounts(ws, all)
        } catch (error: Exception) {
            if (workspace != ws) return
            cache.accounts(ws)?.takeIf { it.isNotEmpty() }?.let { accountsState.value = it }
        } finally {
            if (workspace == ws) accountsLoadedState.value = true
        }
        // A saved mailbox that is gone (or in another workspace) falls back to all inboxes.
        val selected = accountId
        if (selected != null && sendableAccounts.none { it.id == selected } && accountsState.value.isNotEmpty()) {
            selectMailbox(Mailbox.Unified)
        }
    }

    fun selectMailbox(mailbox: Mailbox) {
        val ws = workspace ?: return
        prefs.edit { putString(selectionKey(ws), if (mailbox is Mailbox.Account) mailbox.id else UNIFIED) }
        if (mailboxState.value == mailbox && labelState.value == SystemLabel.INBOX.slug) return
        mailboxState.value = mailbox
        labelState.value = SystemLabel.INBOX.slug
        labelsState.value = LabelState()
        env.scope.launch {
            reloadList()
            loadLabels()
        }
    }

    /**
     * Follows a notification into the mailbox the email arrived in; the
     * unified inbox already lists it and stays.
     */
    fun followAccount(accountId: String?) {
        if (accountId == null || mailboxState.value is Mailbox.Unified) {
            if (labelState.value != SystemLabel.INBOX.slug) selectLabel(SystemLabel.INBOX.slug)
            return
        }
        if (sendableAccounts.any { it.id == accountId }) selectMailbox(Mailbox.Account(accountId)) else selectLabel(SystemLabel.INBOX.slug)
    }

    fun selectLabel(slug: String) {
        if (labelState.value == slug) return
        labelState.value = slug
        env.scope.launch { reloadList() }
    }

    suspend fun loadLabels() {
        val ws = workspace ?: return
        val mailbox = mailboxState.value
        val scope = mailbox.key
        try {
            val rows = repository.labels((mailbox as? Mailbox.Account)?.id)
            val state = MailLogic.processLabels(rows)
            val drafts = runCatching { repository.stats((mailbox as? Mailbox.Account)?.id).drafts }.getOrNull()
            val withDrafts = if (drafts != null) state.copy(systemCounts = state.systemCounts + (SystemLabel.DRAFTS.slug to drafts)) else state
            if (workspace != ws || mailboxState.value != mailbox) return
            labelsState.value = withDrafts
            cache.putLabels(ws, scope, withDrafts)
        } catch (error: Exception) {
            if (workspace != ws || mailboxState.value != mailbox) return
            cache.labels(ws, scope)?.let { labelsState.value = it }
        }
    }

    suspend fun createLabel(accountId: String, name: String, color: String?) {
        repository.createLabel(accountId, name, color)
        loadLabels()
    }

    // ---------------------------------------------------------------- the list

    /** Another list on screen: this session's snapshot or the cache at once, then the server. */
    private suspend fun reloadList() {
        val ws = workspace ?: return
        val key = scopeKey
        val generation = ++listGeneration
        val snapshot = snapshots[key]
        inboxState.value = snapshot?.copy(loading = false, refreshing = false, loadingMore = false) ?: InboxState(loading = true)
        if (snapshot == null) {
            val cached = cache.messages(ws, mailboxState.value.key, labelState.value)
            if (generation == listGeneration && !cached.isNullOrEmpty()) {
                inboxState.value = InboxState(messages = overlay(cached), loading = false)
            }
        }
        refresh()
    }

    /** Reloads the first page and folds it onto what is on screen. */
    suspend fun refresh(pullToRefresh: Boolean = false) {
        val ws = workspace ?: return
        val key = scopeKey
        val generation = listGeneration
        val mailbox = mailboxState.value
        val label = labelState.value
        if (pullToRefresh) inboxState.update { it.copy(refreshing = true) }
        try {
            val page = repository.messages(accountId = (mailbox as? Mailbox.Account)?.id, label = label)
            if (generation != listGeneration || scopeKey != key) return
            val fresh = MailLogic.withThreadCounts(page.messages)
            val overlaid = overlay(fresh)
            val current = inboxState.value
            val (merged, cursor) = MailLogic.mergeFirstPage(current.messages, overlaid, page.cursor, current.cursor, current.cursorKnown)
            setList(key, InboxState(messages = MailLogic.withThreadCounts(merged), cursor = cursor, cursorKnown = true, loading = false))
            cache.putMessages(ws, mailbox.key, label, fresh)
            labelsState.update { state ->
                if (SystemLabel.of(label) != null) {
                    state.copy(systemCounts = state.systemCounts + (label to fresh.count { !it.isRead }))
                } else {
                    state.copy(custom = state.custom.map { if (it.slug == label) it.copy(count = fresh.count { m -> !m.isRead }) else it })
                }
            }
        } catch (error: Exception) {
            if (generation != listGeneration || scopeKey != key) return
            // Offline or refused: keep what is on screen.
            inboxState.update { it.copy(loading = false, refreshing = false, error = error) }
        }
    }

    /** The next page, when the list nears its end. */
    fun loadMore() {
        val state = inboxState.value
        val cursor = state.cursor ?: return
        if (state.loadingMore || listJob?.isActive == true) return
        val key = scopeKey
        val generation = listGeneration
        val mailbox = mailboxState.value
        val label = labelState.value
        inboxState.update { it.copy(loadingMore = true) }
        listJob = env.scope.launch {
            try {
                val page = repository.messages(accountId = (mailbox as? Mailbox.Account)?.id, label = label, cursor = cursor)
                if (generation != listGeneration || scopeKey != key || inboxState.value.cursor != cursor) return@launch
                val next = MailLogic.withThreadCounts(MailLogic.appendPage(inboxState.value.messages, overlay(page.messages)))
                setList(key, inboxState.value.copy(messages = next, cursor = page.cursor, cursorKnown = true, loadingMore = false))
            } catch (error: Exception) {
                // The cursor stays: scrolling to the end again retries the page.
                inboxState.update { it.copy(loadingMore = false) }
            }
        }
    }

    private fun setList(key: String, state: InboxState) {
        inboxState.value = state
        snapshots[key] = state
    }

    private fun changeList(change: (List<MailMessage>) -> List<MailMessage>) {
        val next = inboxState.value.copy(messages = change(inboxState.value.messages))
        setList(scopeKey, next)
    }

    /**
     * A notification opened an email the list may not have yet (the push can
     * beat the list): reload a few times until it shows up.
     */
    fun expect(emailId: String?) {
        expectedState.value = emailId
        if (emailId == null) return
        env.scope.launch {
            for (wait in listOf(0L, 400L, 1_000L, 2_000L, 4_000L)) {
                delay(wait)
                if (expectedState.value != emailId) return@launch
                refresh()
                if (inboxState.value.messages.any { it.id == emailId }) break
            }
            if (expectedState.value == emailId) expectedState.value = null
        }
    }

    // ---------------------------------------------------------------- changes

    private suspend fun overlay(list: List<MailMessage>): List<MailMessage> {
        val ws = workspace ?: return list
        return OutboxRules.overlay(list, outbox.load(ws), labelState.value)
    }

    private fun newOpId() = "op_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}"

    private suspend fun enqueue(op: OutboxOp) {
        val ws = workspace ?: return
        pendingState.value = outbox.enqueue(ws, op).size
        env.scope.launch { flush() }
    }

    private suspend fun patchCached(id: String, patch: FlagPatch) {
        val ws = workspace ?: return
        cache.message(ws, id)?.let { cache.putMessage(ws, patch.applyTo(it)) }
    }

    suspend fun setRead(id: String, read: Boolean) {
        changeList { list -> list.map { if (it.id == id) it.copy(isRead = read) else it } }
        val patch = FlagPatch(isRead = read)
        patchCached(id, patch)
        enqueue(OutboxOp.Update(newOpId(), id, patch, createdAt = System.currentTimeMillis()))
    }

    suspend fun setStarred(id: String, starred: Boolean) {
        changeList { list -> list.map { if (it.id == id) it.copy(isStarred = starred) else it } }
        val patch = FlagPatch(isStarred = starred)
        patchCached(id, patch)
        enqueue(OutboxOp.Update(newOpId(), id, patch, createdAt = System.currentTimeMillis()))
    }

    suspend fun markSpam(id: String) {
        changeList { list -> list.filterNot { it.id == id } }
        enqueue(OutboxOp.Update(newOpId(), id, FlagPatch(isSpam = true), createdAt = System.currentTimeMillis()))
    }

    suspend fun archive(id: String) {
        changeList { list -> list.filterNot { it.id == id } }
        enqueue(OutboxOp.Archive(newOpId(), id, createdAt = System.currentTimeMillis()))
    }

    suspend fun delete(id: String) {
        changeList { list -> list.filterNot { it.id == id } }
        enqueue(OutboxOp.Delete(newOpId(), id, createdAt = System.currentTimeMillis()))
    }

    suspend fun snooze(message: MailMessage, until: String) {
        changeList { list -> list.filterNot { it.id == message.id } }
        enqueue(OutboxOp.Snooze(newOpId(), message.id, message.accountId, until, createdAt = System.currentTimeMillis()))
    }

    /** Undo a snooze: back at the top of the list. */
    suspend fun unsnooze(message: MailMessage) {
        changeList { list -> listOf(message) + list.filterNot { it.id == message.id } }
        enqueue(OutboxOp.Unsnooze(newOpId(), message.id, message.accountId, createdAt = System.currentTimeMillis()))
    }

    /** A labels change on the message screen, reflected in the list. */
    fun labelsChanged(id: String, labels: List<String>) {
        changeList { list -> list.map { if (it.id == id) it.copy(labels = labels) else it } }
    }

    /**
     * Pins or unpins a message with the server's `PINNED` label, as the
     * platform does, so the pin shows on the web and on every device. The list
     * and the cache change at once; a refused change puts them back and throws.
     * Returns the message's labels as the server has them.
     */
    suspend fun setPinned(id: String, labels: List<String>, on: Boolean): List<String> {
        applyLabels(id, MailLogic.withPinned(labels, on))
        try {
            val pin = listOf(MailLogic.PINNED_LABEL)
            val next = repository.changeLabels(id, if (on) pin else emptyList(), if (on) emptyList() else pin, labels)
            applyLabels(id, next)
            return next
        } catch (error: Exception) {
            applyLabels(id, labels)
            throw error
        }
    }

    private suspend fun applyLabels(id: String, labels: List<String>) {
        labelsChanged(id, labels)
        val ws = workspace ?: return
        cache.message(ws, id)?.let { cache.putMessage(ws, it.copy(labels = labels)) }
    }

    /**
     * Pins used to be kept on the phone only. Those are pinned on the server
     * once; a message that is gone is let go, one that fails for another
     * reason (offline) is tried again next time.
     */
    private suspend fun migrateLocalPins() {
        val ids = prefs.getStringSet(LOCAL_PINS, null) ?: return
        val left = ids.filterNot { id ->
            try {
                repository.changeLabels(id, listOf(MailLogic.PINNED_LABEL), emptyList(), emptyList())
                true
            } catch (error: Exception) {
                (error as? ApiException)?.status == 404
            }
        }.toSet()
        prefs.edit { if (left.isEmpty()) remove(LOCAL_PINS) else putStringSet(LOCAL_PINS, left) }
        if (left.size < ids.size) refresh()
    }

    /** A send made offline: it goes out when the phone is back online, once (its idempotency key). */
    suspend fun queueSend(accountId: String, payload: SendPayload) {
        enqueue(OutboxOp.Send(newOpId(), accountId, payload, createdAt = System.currentTimeMillis()))
    }

    private suspend fun refreshPending() {
        val ws = workspace ?: return
        pendingState.value = outbox.load(ws).size
    }

    /** Sends what waits in the outbox, and reloads when anything changed on the server. */
    suspend fun flush() {
        val ws = workspace ?: return
        val result = outbox.flush(ws, ::run, ::classify) ?: return
        pendingState.value = result.remaining
        if (result.shouldReconcile && workspace == ws) refresh()
    }

    private suspend fun run(op: OutboxOp) {
        when (op) {
            is OutboxOp.Update -> repository.update(op.messageId, op.patch)
            is OutboxOp.Delete -> repository.delete(op.messageId)
            is OutboxOp.Archive -> repository.archive(op.messageId)
            is OutboxOp.Snooze -> repository.snooze(op.accountId, op.messageId, op.until)
            is OutboxOp.Unsnooze -> repository.unsnooze(op.accountId, op.messageId)
            is OutboxOp.Send -> repository.send(op.accountId, op.payload)
        }
    }

    private fun classify(error: Throwable): FailureKind {
        if (MailRepository.isNetwork(error)) return FailureKind.NETWORK
        val status = (error as? ApiException)?.status ?: (error as? SendFailure)?.status
        return when {
            status == null -> FailureKind.REJECTED
            status >= 500 || status == 429 || status == 408 || status == 401 -> FailureKind.TRANSIENT
            else -> FailureKind.REJECTED
        }
    }

    // ---------------------------------------------------------------- one message

    suspend fun cachedMessage(id: String): MailMessage? = workspace?.let { cache.message(it, id) }

    suspend fun cachedThread(id: String): List<MailMessage>? = workspace?.let { cache.thread(it, id) }

    suspend fun remember(message: MailMessage) {
        workspace?.let { cache.putMessage(it, message) }
    }

    suspend fun rememberThread(id: String, list: List<MailMessage>) {
        workspace?.let { cache.putThread(it, id, list) }
    }

    // ---------------------------------------------------------------- subscriptions

    private val subscriptionCache = mutableMapOf<String, Pair<Long, List<MailSubscription>>>()

    /**
     * A mailbox's subscriptions, kept for a minute, so opening emails one
     * after another doesn't reload the list for every Unsubscribe button.
     */
    suspend fun subscriptionsCached(accountId: String): List<MailSubscription> {
        subscriptionCache[accountId]?.let { (at, list) -> if (System.currentTimeMillis() - at < SUBSCRIPTIONS_TTL) return list }
        val list = repository.subscriptions(accountId)
        subscriptionCache[accountId] = System.currentTimeMillis() to list
        return list
    }

    /** After an unsubscribe or a scan the list is read again. */
    fun forgetSubscriptions(accountId: String) {
        subscriptionCache.remove(accountId)
    }

    // ---------------------------------------------------------------- drafts

    private var lastDraft: DraftContent? = null
    private var lastDraftId: String? = null
    private var draftJob: Job? = null

    /** What the composer held when it closed. */
    data class DraftContent(
        val accountId: String,
        val to: List<String>,
        val cc: List<String>,
        val bcc: List<String>,
        val subject: String,
        val body: String,
        val html: Boolean,
    )

    /** Keeps a closed composer's content as a draft, in the background. */
    fun saveDraft(content: DraftContent) {
        lastDraft = content
        lastDraftId = null
        draftJob = env.scope.launch {
            lastDraftId = runCatching {
                repository.createDraft(content.accountId, content.to, content.cc, content.bcc, content.subject, content.body, content.html)
            }.getOrNull()
        }
    }

    /** "Discard" on the "Draft saved" bar: waits for the draft if it is still being saved. */
    suspend fun discardDraft() {
        draftJob?.join()
        val id = lastDraftId ?: return
        runCatching { repository.deleteDraft(id) }
        lastDraftId = null
    }

    /** "Undo" on the "Draft discarded" bar. */
    fun restoreDraft() {
        lastDraft?.let(::saveDraft)
    }

    private companion object {
        const val UNIFIED = "unified"
        /** Where the phone-only pins were kept, before pins moved to the server. */
        const val LOCAL_PINS = "pinned"
        const val SUBSCRIPTIONS_TTL = 60_000L
    }
}
