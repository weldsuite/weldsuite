package com.weldsuite.weldchat

import java.time.ZoneId
import kotlin.math.roundToInt

// How a message's text splits into mentions, links and inline files, how
// call events pair up, how messages group. Pure, so MessageTextTest covers
// them. The same rules as the iOS app's ChatLogic.swift.

/** A piece of a message body: text, or one of its attachments placed in it. */
sealed interface MessageBlock {
    data class Text(val text: String) : MessageBlock
    data class File(val id: String) : MessageBlock
}

/** A run of message text: plain, a link, or a mention. */
sealed interface TextRun {
    data class Plain(val text: String) : TextRun
    data class Link(val text: String, val url: String) : TextRun
    data class Mention(val text: String) : TextRun
}

object MentionText {
    private val tokenRegex = Regex("<@([^>]+)>")

    /** A `<@…>` token: where it is in the text, and what's inside. */
    data class Token(val range: IntRange, val body: String)

    /** Whether an id names a WeldAgent workspace agent rather than a person. */
    fun isAgentId(id: String): Boolean = id.startsWith("agt_")

    /** The attachment id of a `<@file:…>` token body, null for any other. */
    fun fileTokenId(token: String): String? =
        if (token.startsWith("file:")) token.removePrefix("file:").takeIf { it.isNotEmpty() } else null

    fun tokens(text: String): List<Token> = tokenRegex.findAll(text).map { Token(it.range, it.groupValues[1]) }.toList()

    /** Attachment ids placed inline, in order, without duplicates. */
    fun fileTokenIds(text: String): List<String> = tokens(text).mapNotNull { fileTokenId(it.body) }.distinct()

    /** [text] without its inline file tokens. */
    fun stripFileTokens(text: String): String {
        val out = StringBuilder()
        var last = 0
        for (token in tokens(text)) {
            if (fileTokenId(token.body) == null) continue
            out.append(text, last, token.range.first)
            last = token.range.last + 1
        }
        out.append(text, last, text.length)
        return out.toString()
    }

    /** The label inside a token: `id|Label`, `id:Label`, or the roster's name. */
    fun label(token: String, names: Map<String, String>): String {
        val pipe = token.indexOf('|')
        if (pipe >= 0) return token.substring(pipe + 1)
        val colon = token.indexOf(':')
        if (colon >= 0) return token.substring(colon + 1)
        return names[token] ?: "unknown"
    }

    /** Mentions as `@Name`, inline files dropped (one-line previews). */
    fun plainText(text: String, names: Map<String, String>): String {
        val out = StringBuilder()
        var last = 0
        for (token in tokens(text)) {
            out.append(text, last, token.range.first)
            if (fileTokenId(token.body) == null) out.append('@').append(label(token.body, names))
            last = token.range.last + 1
        }
        out.append(text, last, text.length)
        return out.toString()
    }

    private val leadingBreak = Regex("^[^\\S\\n]*\\n")
    private val trailingBreak = Regex("\\n[^\\S\\n]*$")

    /**
     * The body split at its inline file tokens; a token whose attachment
     * isn't known is dropped, and so are the line breaks around a file.
     */
    fun blocks(text: String, attachmentIds: Set<String>): List<MessageBlock> {
        val blocks = mutableListOf<MessageBlock>()
        val pending = StringBuilder()
        var last = 0
        fun pushText(afterFile: Boolean, beforeFile: Boolean) {
            var chunk = pending.toString()
            if (afterFile) chunk = leadingBreak.replaceFirst(chunk, "")
            if (beforeFile) chunk = trailingBreak.replaceFirst(chunk, "")
            if (chunk.isNotBlank()) blocks.add(MessageBlock.Text(chunk))
            pending.clear()
        }
        for (token in tokens(text)) {
            val id = fileTokenId(token.body) ?: continue
            pending.append(text, last, token.range.first)
            last = token.range.last + 1
            if (id !in attachmentIds) continue
            pushText(afterFile = blocks.lastOrNull() is MessageBlock.File, beforeFile = true)
            blocks.add(MessageBlock.File(id))
        }
        pending.append(text, last, text.length)
        pushText(afterFile = blocks.lastOrNull() is MessageBlock.File, beforeFile = false)
        return blocks
    }

    /** Text with mentions as badges and web addresses as links. */
    fun runs(text: String, names: Map<String, String>): List<TextRun> {
        val runs = mutableListOf<TextRun>()
        var last = 0
        for (token in tokens(text)) {
            if (token.range.first > last) runs.addAll(LinkText.runs(text.substring(last, token.range.first)))
            if (fileTokenId(token.body) == null) runs.add(TextRun.Mention("@" + label(token.body, names)))
            last = token.range.last + 1
        }
        if (last < text.length) runs.addAll(LinkText.runs(text.substring(last)))
        return runs
    }

    private val mentionQueryRegex = Regex("(?:^|\\s)@([^\\s@<>]*)$")
    private val trailingMention = Regex("@[^\\s@<>]*$")

    /**
     * The `@query` being typed at the end of the text, or null. `@` must
     * start the text or follow whitespace, so e-mail addresses don't count.
     */
    fun mentionQuery(text: String): String? = mentionQueryRegex.find(text)?.groupValues?.get(1)

    /** The trailing `@query` swapped for the member's token. */
    fun insertMention(text: String, userId: String): String {
        val match = trailingMention.find(text) ?: return text
        return text.replaceRange(match.range, "<@$userId> ")
    }
}

object LinkText {
    private val pattern = Regex("\\b(?:https?://|www\\.)[^\\s<]*[^\\s<.,:;\"')\\]!?]", RegexOption.IGNORE_CASE)

    /** A web address in a text: where, as written, and what to open. */
    data class Found(val range: IntRange, val text: String, val url: String)

    fun find(text: String): List<Found> = pattern.findAll(text).map { match ->
        val written = match.value
        Found(match.range, written, if (written.lowercase().startsWith("http")) written else "https://$written")
    }.toList()

    fun runs(text: String): List<TextRun> {
        val runs = mutableListOf<TextRun>()
        var last = 0
        for (link in find(text)) {
            if (link.range.first > last) runs.add(TextRun.Plain(text.substring(last, link.range.first)))
            runs.add(TextRun.Link(link.text, link.url))
            last = link.range.last + 1
        }
        if (last < text.length) runs.add(TextRun.Plain(text.substring(last)))
        return runs
    }
}

// MARK: Calls in the conversation

/** A call event the server posts as a `system` message. */
sealed interface CallEvent {
    data class Start(val isVideo: Boolean) : CallEvent
    data class Ended(val isVideo: Boolean, val duration: String?) : CallEvent
    data class Missed(val isVideo: Boolean) : CallEvent
}

/** One call, shown as a single card where it started. */
data class CallLogEntry(
    val outcome: Outcome?,
    val isVideo: Boolean,
    val duration: String? = null,
    val callerId: String,
    val callerName: String,
    val callerAvatar: String?,
) {
    enum class Outcome { ENDED, MISSED }
}

object CallLog {
    private val started = Regex(" started an? (voice |video )?call$")

    fun parse(content: String): CallEvent? {
        val text = content.lowercase()
        val isVideo = "video call" in text
        if (text.startsWith("missed") && text.endsWith("call")) return CallEvent.Missed(isVideo)
        if (text.startsWith("call ended")) {
            val parts = content.split("—")
            val duration = if (parts.size > 1) parts[1].trim() else ""
            return CallEvent.Ended(isVideo, duration.ifEmpty { null })
        }
        if (started.containsMatchIn(text)) return CallEvent.Start(isVideo)
        return null
    }

    data class Built(val entries: Map<String, CallLogEntry>, val folded: Set<String>, val openId: String?)

    /**
     * Pair each call's start and end messages (chronological input). The
     * end folds into its start's card; an end whose start isn't loaded
     * stands alone.
     */
    fun build(chronological: List<ChatMessage>): Built {
        val entries = mutableMapOf<String, CallLogEntry>()
        val folded = mutableSetOf<String>()
        var openId: String? = null
        for (message in chronological) {
            if (!message.isSystem) continue
            val outcome: CallLogEntry.Outcome
            val isVideo: Boolean
            val lasted: String?
            when (val event = parse(message.content) ?: continue) {
                is CallEvent.Start -> {
                    entries[message.id] = CallLogEntry(null, event.isVideo, null, message.authorId, message.authorName, message.authorAvatar)
                    openId = message.id
                    continue
                }
                is CallEvent.Ended -> {
                    outcome = CallLogEntry.Outcome.ENDED
                    isVideo = event.isVideo
                    lasted = event.duration
                }
                is CallEvent.Missed -> {
                    outcome = CallLogEntry.Outcome.MISSED
                    isVideo = event.isVideo
                    lasted = null
                }
            }
            val open = openId
            val start = open?.let { entries[it] }
            if (open != null && start != null) {
                entries[open] = start.copy(outcome = outcome, duration = lasted)
                folded.add(message.id)
                openId = null
            } else {
                entries[message.id] = CallLogEntry(outcome, isVideo, lasted, message.authorId, message.authorName, message.authorAvatar)
            }
        }
        return Built(entries, folded, openId)
    }

    /** "2m 34s" → 154; null without a duration. */
    fun seconds(duration: String?): Int? {
        var total: Int? = null
        for (part in duration.orEmpty().split(' ')) {
            val unit = part.lastOrNull() ?: continue
            val amount = part.dropLast(1).toIntOrNull() ?: continue
            when (unit) {
                'm' -> total = (total ?: 0) + amount * 60
                's' -> total = (total ?: 0) + amount
            }
        }
        return total
    }

    /** "a few seconds", "3 minutes", "2 hours". */
    fun lasted(duration: String?): UiText? {
        val seconds = seconds(duration) ?: return null
        if (seconds < 60) return UiText.Res(R.string.weldchat_channel_call_few_seconds)
        if (seconds < 3600) return UiText.Plural(R.plurals.weldchat_channel_call_minutes, (seconds / 60.0).roundToInt())
        return UiText.Plural(R.plurals.weldchat_channel_call_hours, (seconds / 3600.0).roundToInt())
    }
}

// MARK: Message layout

object MessageLayout {
    /** The compact-row window: one author's messages within five minutes. */
    private const val COMPACT_MS = 300_000L

    /** The chronologically previous message is on another day (or there is none). */
    fun startsNewDay(item: ChatMessage, previous: ChatMessage?, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        val a = item.instant ?: return true
        val b = previous?.instant ?: return true
        return !ChatDates.sameDay(a, b, zone)
    }

    /** One author's messages within five minutes collapse to compact rows. */
    fun isCompact(item: ChatMessage, previous: ChatMessage?): Boolean {
        if (previous == null || previous.isSystem || previous.authorId != item.authorId) return false
        if (item.parentId != null || item.replyTo != null) return false
        val a = item.instant ?: return false
        val b = previous.instant ?: return false
        val gap = a.toEpochMilli() - b.toEpochMilli()
        return gap in 0 until COMPACT_MS
    }

    /** Oldest first. */
    fun chronological(messages: List<ChatMessage>): List<ChatMessage> = messages.sortedBy { DmLogic.time(it.createdAt) }

    /**
     * A refresh of the newest page: older loaded pages stay, optimistic sends
     * stay until their server copy arrives.
     */
    fun merge(existing: List<ChatMessage>, fetched: List<ChatMessage>, pending: List<ChatMessage>): List<ChatMessage> {
        val fetchedIds = fetched.map { it.id }.toSet()
        val oldest = fetched.minOfOrNull { DmLogic.time(it.createdAt) } ?: Long.MAX_VALUE
        val older = existing.filter { !it.pending && it.id !in fetchedIds && DmLogic.time(it.createdAt) < oldest }
        return older + fetched + pending
    }
}
