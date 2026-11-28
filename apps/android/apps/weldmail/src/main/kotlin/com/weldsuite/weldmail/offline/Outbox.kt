package com.weldsuite.weldmail.offline

import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.SendPayload
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import org.weldsuite.core.WeldJson
import java.io.File

/** A message's flags that can change while offline. */
@Serializable
data class FlagPatch(
    val isRead: Boolean? = null,
    val isStarred: Boolean? = null,
    val isSpam: Boolean? = null,
    val isImportant: Boolean? = null,
) {
    fun merge(newer: FlagPatch) = FlagPatch(
        isRead = newer.isRead ?: isRead,
        isStarred = newer.isStarred ?: isStarred,
        isSpam = newer.isSpam ?: isSpam,
        isImportant = newer.isImportant ?: isImportant,
    )

    fun applyTo(message: MailMessage): MailMessage = message.copy(
        isRead = isRead ?: message.isRead,
        isStarred = isStarred ?: message.isStarred,
        isImportant = isImportant ?: message.isImportant,
    )
}

/**
 * A change made on the phone that waits for the server: it shows at once
 * and survives restarts and being offline (the Expo app's `lib/offline/outbox.ts`).
 */
@Serializable
sealed interface OutboxOp {
    val id: String
    val attempts: Int
    val createdAt: Long

    /** The message it changes; null for a send. */
    val messageId: String?

    fun retried(): OutboxOp

    @Serializable
    @SerialName("update")
    data class Update(
        override val id: String,
        override val messageId: String,
        val patch: FlagPatch,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override fun retried() = copy(attempts = attempts + 1)
    }

    @Serializable
    @SerialName("delete")
    data class Delete(
        override val id: String,
        override val messageId: String,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override fun retried() = copy(attempts = attempts + 1)
    }

    @Serializable
    @SerialName("archive")
    data class Archive(
        override val id: String,
        override val messageId: String,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override fun retried() = copy(attempts = attempts + 1)
    }

    @Serializable
    @SerialName("snooze")
    data class Snooze(
        override val id: String,
        override val messageId: String,
        val accountId: String,
        val until: String,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override fun retried() = copy(attempts = attempts + 1)
    }

    @Serializable
    @SerialName("unsnooze")
    data class Unsnooze(
        override val id: String,
        override val messageId: String,
        val accountId: String,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override fun retried() = copy(attempts = attempts + 1)
    }

    /** A composed message; its idempotency key makes a replay safe. */
    @Serializable
    @SerialName("send")
    data class Send(
        override val id: String,
        val accountId: String,
        val payload: SendPayload,
        override val attempts: Int = 0,
        override val createdAt: Long,
    ) : OutboxOp {
        override val messageId: String? get() = null

        override fun retried() = copy(attempts = attempts + 1)
    }
}

/** What a flush did. */
data class FlushResult(val remaining: Int, val succeeded: Int, val dropped: Int) {
    /** Something changed on the server (or was refused): reload to its state. */
    val shouldReconcile: Boolean get() = succeeded > 0 || dropped > 0
}

/** How a replayed op failed. */
enum class FailureKind {
    /** Offline: keep it and everything after it, and stop. */
    NETWORK,

    /** 5xx, rate limited, a session not ready: keep it, one attempt spent. */
    TRANSIENT,

    /** Refused: drop it (the server wins). */
    REJECTED,
}

/** The queue's rules, without storage or network. */
object OutboxRules {
    /** An op that failed this many flushes is dropped so it can't wedge the queue. */
    const val MAX_ATTEMPTS = 6

    /**
     * Folds a new op into the queue: flag changes merge, a delete supersedes
     * everything else for its message, an archive is queued once, the latest
     * snooze or unsnooze wins, sends never merge.
     */
    fun collapse(ops: List<OutboxOp>, incoming: OutboxOp): List<OutboxOp> {
        if (incoming is OutboxOp.Send) return ops + incoming
        val target = incoming.messageId
        val same = { op: OutboxOp -> op !is OutboxOp.Send && op.messageId == target }
        if (incoming is OutboxOp.Delete) return ops.filterNot(same) + incoming
        if (ops.any { same(it) && it is OutboxOp.Delete }) return ops
        return when (incoming) {
            is OutboxOp.Update -> {
                val existing = ops.firstOrNull { same(it) && it is OutboxOp.Update } as OutboxOp.Update?
                if (existing == null) {
                    ops + incoming
                } else {
                    val merged = existing.copy(patch = existing.patch.merge(incoming.patch), attempts = 0)
                    ops.map { if (it === existing) merged else it }
                }
            }
            is OutboxOp.Archive -> if (ops.any { same(it) && it is OutboxOp.Archive }) ops else ops + incoming
            is OutboxOp.Snooze, is OutboxOp.Unsnooze ->
                ops.filterNot { same(it) && (it is OutboxOp.Snooze || it is OutboxOp.Unsnooze) } + incoming
            else -> ops + incoming
        }
    }

    /**
     * The queue laid over a list: flags patched, and messages a pending op
     * moved out of this folder hidden (deleted anywhere, archived outside
     * Archive, snoozed outside Snoozed).
     */
    fun overlay(messages: List<MailMessage>, ops: List<OutboxOp>, label: String?): List<MailMessage> {
        if (ops.isEmpty()) return messages
        val byMessage = ops.filter { it !is OutboxOp.Send }.groupBy { it.messageId }
        val folder = label?.uppercase().orEmpty()
        return messages.mapNotNull { message ->
            val pending = byMessage[message.id] ?: return@mapNotNull message
            if (hidden(pending, folder)) return@mapNotNull null
            pending.filterIsInstance<OutboxOp.Update>().fold(message) { acc, op -> op.patch.applyTo(acc) }
        }
    }

    private fun hidden(ops: List<OutboxOp>, folder: String): Boolean = when {
        ops.any { it is OutboxOp.Delete } -> true
        ops.any { it is OutboxOp.Archive } && folder != "ARCHIVE" -> true
        ops.any { it is OutboxOp.Snooze } && folder != "SNOOZED" -> true
        else -> ops.any { it is OutboxOp.Unsnooze } && folder == "SNOOZED"
    }

    /**
     * One pass over the queue: an op that worked is removed; offline stops
     * the pass and keeps the rest; a transient failure spends an attempt; a
     * refusal drops the op. Returns the ops handled and those to retry.
     */
    suspend fun replay(
        ops: List<OutboxOp>,
        run: suspend (OutboxOp) -> Unit,
        classify: (Throwable) -> FailureKind,
    ): Replay {
        val handled = mutableSetOf<String>()
        val retried = mutableMapOf<String, OutboxOp>()
        var succeeded = 0
        var dropped = 0
        for (op in ops) {
            if (op.attempts >= MAX_ATTEMPTS) {
                handled += op.id
                dropped++
                continue
            }
            try {
                run(op)
                handled += op.id
                succeeded++
            } catch (error: Exception) {
                when (classify(error)) {
                    FailureKind.NETWORK -> break
                    FailureKind.TRANSIENT -> retried[op.id] = op.retried()
                    FailureKind.REJECTED -> {
                        handled += op.id
                        dropped++
                    }
                }
            }
        }
        return Replay(handled, retried, succeeded, dropped)
    }

    data class Replay(
        val handled: Set<String>,
        val retried: Map<String, OutboxOp>,
        val succeeded: Int,
        val dropped: Int,
    ) {
        /**
         * The pass merged into the queue as it is now: ops enqueued meanwhile
         * stay; an op whose content changed meanwhile (a merged update) runs again.
         */
        fun applyTo(current: List<OutboxOp>, before: List<OutboxOp>): List<OutboxOp> {
            val snapshot = before.associateBy { it.id }
            return current.mapNotNull { op ->
                val unchanged = snapshot[op.id] == op
                when {
                    unchanged && op.id in handled -> null
                    unchanged && op.id in retried -> retried[op.id]
                    else -> op
                }
            }
        }
    }
}

/**
 * The queue of one workspace, kept in a file on the phone. Reads and writes
 * of the queue are serialised; network calls run outside the lock.
 */
class OutboxStore(private val directory: File) {
    private val lock = Mutex()
    private val flushing = Mutex()
    private val again = java.util.concurrent.atomic.AtomicBoolean(false)
    private val serializer = ListSerializer(OutboxOp.serializer())

    private fun file(workspace: String) = File(directory, "${safe(workspace)}.json")

    suspend fun load(workspace: String): List<OutboxOp> = lock.withLock { read(workspace) }

    suspend fun enqueue(workspace: String, op: OutboxOp): List<OutboxOp> = lock.withLock {
        val next = OutboxRules.collapse(read(workspace), op)
        write(workspace, next)
        next
    }

    /**
     * Replays the queue. A call while a flush runs returns null at once but
     * makes the running flush take one more pass, so the op that triggered it
     * goes out now rather than at the next trigger.
     */
    suspend fun flush(
        workspace: String,
        run: suspend (OutboxOp) -> Unit,
        classify: (Throwable) -> FailureKind,
    ): FlushResult? {
        if (!flushing.tryLock()) {
            again.set(true)
            return null
        }
        try {
            var total: FlushResult? = null
            do {
                again.set(false)
                val result = pass(workspace, run, classify)
                total = total?.let { FlushResult(result.remaining, it.succeeded + result.succeeded, it.dropped + result.dropped) } ?: result
            } while (again.get())
            return total
        } finally {
            flushing.unlock()
        }
    }

    private suspend fun pass(workspace: String, run: suspend (OutboxOp) -> Unit, classify: (Throwable) -> FailureKind): FlushResult {
        val before = load(workspace)
        if (before.isEmpty()) return FlushResult(0, 0, 0)
        val pass = OutboxRules.replay(before, run, classify)
        return lock.withLock {
            val next = pass.applyTo(read(workspace), before)
            write(workspace, next)
            FlushResult(next.size, pass.succeeded, pass.dropped)
        }
    }

    /** Forget every queue: at sign-out nobody else replays this person's changes. */
    suspend fun clearAll() = lock.withLock {
        directory.listFiles()?.forEach { it.delete() }
    }

    private fun read(workspace: String): List<OutboxOp> {
        val file = file(workspace)
        if (!file.exists()) return emptyList()
        return runCatching { WeldJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())
    }

    private fun write(workspace: String, ops: List<OutboxOp>) {
        directory.mkdirs()
        val file = file(workspace)
        if (ops.isEmpty()) {
            file.delete()
            return
        }
        val temp = File(directory, "${file.name}.tmp")
        temp.writeText(WeldJson.encodeToString(serializer, ops))
        temp.renameTo(file)
    }

    private fun safe(name: String) = name.replace(Regex("[^A-Za-z0-9_-]"), "_")
}
