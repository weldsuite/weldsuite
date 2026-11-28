package com.weldsuite.weldchat

import org.weldsuite.core.WeldDate
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin
import org.weldsuite.core.R as CoreR

// The rules behind the screens, without the screens: what is unread, how a
// DM is named, which record chats Home shows, how dates read, where a push
// or a link leads. Pure, so ChatLogicTest covers them. The same rules as
// the iOS app's ChatLogic.swift.

object ChatLogic {
    /** How many recent conversations Home shows before "See all". */
    const val RECENT_DM_COUNT = 5

    /** The bookmark list is fetched with this cap; at the cap the count reads "50+". */
    const val SAVED_CAP = 50

    /** Replying this deep in a reply chain suggests a thread, as Discord does. */
    const val THREAD_SUGGESTION_DEPTH = 2

    /** Shorter voice messages are dropped: almost always an accidental tap. */
    const val MIN_VOICE_MESSAGE_MS = 1_000L

    /** At most this many pinned messages per channel. */
    const val PIN_LIMIT = 3

    const val UNSECTIONED_ID = "__unsectioned__"

    val quickEmojis = listOf("👍", "❤️", "😂", "😮", "🙏", "🔥")
    val emojiList = listOf(
        "👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👏",
        "🙌", "💯", "🤔", "👀", "🚀", "✅", "❌", "⭐",
        "💪", "🙏", "😍", "🤣", "😅", "🥳", "🤝", "💡",
        "📌", "🎯", "💬", "📎", "🔗", "⚡", "🏆", "🌟",
    )

    /** A message since you last read it, or a mention. */
    fun isChannelUnread(channel: ChatChannel): Boolean {
        if (channel.unreadMentionCount > 0) return true
        if (!channel.hasReadState) return false
        val last = WeldDate.parse(channel.lastMessageAt) ?: return false
        val read = WeldDate.parse(channel.lastReadAt) ?: return true
        return last > read
    }

    data class ChannelGroup(val id: String, val name: String, val channels: List<ChatChannel>)

    /**
     * Regular channels by section, as the platform's sidebar: the sections
     * in their order, then the default group with the unsectioned ones. The
     * default group is always there while there are no sections (so a new
     * workspace still sees "Channels" and its "Add channel"), and whenever a
     * channel has no section (or one that is gone); it is called
     * [otherName] when a section already has the name "Channels".
     */
    fun groupSections(channels: List<ChatChannel>, sections: List<ChatSection>, defaultName: String, otherName: String = defaultName): List<ChannelGroup> {
        val groups = sections.map { section -> ChannelGroup(section.id, section.name, channels.filter { it.sectionId == section.id }) }.toMutableList()
        val known = sections.map { it.id }.toSet()
        val unsectioned = channels.filter { it.sectionId == null || it.sectionId !in known }
        if (sections.isEmpty() || unsectioned.isNotEmpty()) {
            val name = if (sections.any { it.name == "Channels" }) otherName else defaultName
            groups.add(ChannelGroup(UNSECTIONED_ID, name, unsectioned))
        }
        return groups
    }

    /** Whether [content] mentions [userId], by name or with @everyone (the platform's highlight). */
    fun mentionsUser(content: String, userId: String): Boolean =
        userId.isNotEmpty() && ("<@$userId>" in content || "<@$userId:" in content || "<@everyone>" in content)
    /** "12 items", or "50+ items" at the cap; null while unknown. */
    fun countLabel(count: Int?, cap: Int? = null): UiText? {
        count ?: return null
        if (cap != null && count >= cap) return UiText.res(R.string.weldchat_home_item_count_capped, cap)
        return UiText.Plural(R.plurals.weldchat_home_item_count, count)
    }

    /** [reactions] with [userId] added to or removed from [emoji]. */
    fun withReaction(reactions: Map<String, List<String>>, emoji: String, userId: String, add: Boolean): Map<String, List<String>> {
        val next = reactions.toMutableMap()
        val users = next[emoji].orEmpty().toMutableList()
        if (add) {
            if (userId !in users) users.add(userId)
            next[emoji] = users
        } else {
            users.remove(userId)
            if (users.isEmpty()) next.remove(emoji) else next[emoji] = users
        }
        return next
    }

    /** Reactions with someone in them, in a stable order. */
    fun reactionEntries(reactions: Map<String, List<String>>): List<Pair<String, List<String>>> =
        reactions.filterValues { it.isNotEmpty() }.toSortedMap().map { it.key to it.value }

    /** The pinned message the bar shows, cycling through the pins. */
    fun pinnedPosition(index: Int, count: Int): Int = if (count > 0) index % count else 0

    /** "Ann is typing…", "Ann and Bob are typing…", "Ann and 2 others are typing…"; [someone] names an unknown person. */
    fun typingLabel(userIds: List<String>, names: Map<String, String>, someone: String): UiText? {
        val first = userIds.firstOrNull() ?: return null
        val name = names[first] ?: someone
        return when (userIds.size) {
            1 -> if (MentionText.isAgentId(first)) {
                UiText.res(R.string.weldchat_channel_agent_working, name)
            } else {
                UiText.res(R.string.weldchat_channel_typing_one, name)
            }
            2 -> UiText.res(R.string.weldchat_channel_typing_two, name, names[userIds[1]] ?: someone.lowercase())
            else -> UiText.res(R.string.weldchat_channel_typing_many, name, userIds.size - 1)
        }
    }

    /** The quote line of a reply: its text in one line, else "Attachment" / "Original message". */
    fun replyQuoteText(reply: ReplyReference, names: Map<String, String>): UiText {
        val text = MentionText.plainText(reply.content, names).split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        if (text.isNotEmpty()) return UiText.Raw(text)
        return UiText.Res(if (reply.hasAttachments) R.string.weldchat_channel_attachment else R.string.weldchat_channel_original_message)
    }

    /** The author name of an optimistic message: the roster, else the first fallback, else "You". */
    fun optimisticAuthorName(userId: String?, names: Map<String, String>, fallbacks: List<String?>): UiText {
        val known = userId?.let { names[it] }?.takeIf { it.isNotEmpty() }
        if (known != null) return UiText.Raw(known)
        return fallbacks.firstOrNull { !it.isNullOrEmpty() }?.let { UiText.Raw(it) } ?: UiText.Res(R.string.weldchat_channel_you)
    }

    /** The web address of a conversation, as the web sidebar links it. */
    fun conversationWebUrl(origin: String, channelId: String, isDm: Boolean, peerUserId: String?): String {
        val base = origin.trimEnd('/')
        if (!isDm) return "$base/weldchat/$channelId"
        if (peerUserId != null) return "$base/weldchat/dm/$peerUserId"
        return "$base/weldchat/dm/group/$channelId"
    }

    /** Activity lists WeldChat's notifications only. */
    fun isChatNotification(category: String, type: String): Boolean = category == "weldchat" || type.startsWith("chat_")

    /** What the Activity tab lists and its badge counts: the server's chat activity feed (`/chat-activity`). */
    val ACTIVITY_TYPES = listOf("chat_mention", "chat_thread_reply", "chat_missed_call")

    /** Whether a notification belongs on Activity: a mention, a reply in your thread or a missed call (a DM's message shows in the DM). */
    fun isActivityItem(category: String, type: String): Boolean = category == "weldchat" && type in ACTIVITY_TYPES

    /** Activity's groups, in the platform's order. */
    enum class ActivityCategory { MENTIONS, REPLIES, CALLS, OTHER }

    /** Which group an activity item goes in (the platform's `activityCategory`). */
    fun activityCategory(type: String): ActivityCategory {
        val lower = type.lowercase()
        return when {
            "mention" in lower -> ActivityCategory.MENTIONS
            "reply" in lower || "thread" in lower -> ActivityCategory.REPLIES
            "call" in lower -> ActivityCategory.CALLS
            else -> ActivityCategory.OTHER
        }
    }

    data class ConversationRef(val channelId: String, val isDm: Boolean)

    /** Where a notification's `actionUrl` points: `/weldchat/dm/<id>` or `/weldchat/<id>`. */
    fun conversationFromActionUrl(url: String?): ConversationRef? {
        url ?: return null
        firstMatch("/weldchat/dm/([^?/#]+)", url)?.takeIf { it != "group" }?.let { return ConversationRef(it, true) }
        firstMatch("/weldchat/dm/group/([^?/#]+)", url)?.let { return ConversationRef(it, true) }
        firstMatch("/weldchat/([^?/#]+)", url)?.let { return ConversationRef(it, false) }
        return null
    }

    fun firstMatch(pattern: String, text: String): String? = Regex(pattern).find(text)?.groupValues?.getOrNull(1)

    /** 65 seconds → "1:05". */
    fun clock(seconds: Long): String {
        val total = seconds.coerceAtLeast(0)
        return "%d:%02d".format(Locale.ROOT, total / 60, total % 60)
    }
}

// MARK: Direct messages

/** The names a DM falls back to, in the app's language. */
data class DmTexts(val unknownMember: String, val groupFallback: String, val fallbackName: String)

object DmLogic {
    /**
     * `mapDm`: name and avatar from the other members, unread from the read
     * marker, pinned from the channel's `pinnedBy`.
     */
    fun conversation(
        id: String,
        type: String,
        storedName: String,
        otherMembers: List<DmPerson>,
        lastMessageAt: String?,
        lastReadAt: String?,
        pinnedBy: List<String>,
        currentUserId: String?,
        isMuted: Boolean,
        lastMessagePreview: String?,
        isArchived: Boolean,
        texts: DmTexts,
    ): DmConversation {
        val others = otherMembers.filter { it.userId.isNotEmpty() }
        val isGroup = others.size > 1
        val name = if (isGroup) {
            val joined = others.joinToString(", ") { it.name ?: it.email ?: texts.unknownMember }
            joined.ifEmpty { storedName.ifEmpty { texts.groupFallback } }
        } else {
            others.firstOrNull()?.let { it.name ?: it.email } ?: storedName.ifEmpty { texts.fallbackName }
        }
        val last = WeldDate.parse(lastMessageAt)
        val read = WeldDate.parse(lastReadAt)
        val hasUnread = last != null && (read == null || last > read)
        return DmConversation(
            id = id,
            name = name,
            picture = if (isGroup) null else others.firstOrNull()?.picture,
            type = type,
            isGroup = isGroup,
            otherMembers = others,
            isMuted = isMuted,
            isPinned = currentUserId != null && currentUserId in pinnedBy,
            hasUnread = hasUnread,
            unreadCount = 0,
            lastMessagePreview = lastMessagePreview,
            lastMessageAt = lastMessageAt,
            isArchived = isArchived,
        )
    }

    enum class Filter(val wire: String) { ALL("all"), UNREAD("unread"), FAVOURITES("favourites"), MUTED("muted") }

    /** The chip filter, then pinned first and newest first. */
    fun sorted(dms: List<DmConversation>, filter: Filter): List<DmConversation> {
        val filtered = when (filter) {
            Filter.ALL -> dms
            Filter.UNREAD -> dms.filter { it.hasUnread }
            Filter.FAVOURITES -> dms.filter { it.isPinned }
            Filter.MUTED -> dms.filter { it.isMuted }
        }
        return filtered.sortedWith(compareByDescending<DmConversation> { it.isPinned }.thenByDescending { time(it.lastMessageAt) })
    }

    /** Newest first. */
    fun recent(dms: List<DmConversation>): List<DmConversation> = dms.sortedByDescending { time(it.lastMessageAt) }

    /** Milliseconds since 1970; 0 for nothing. */
    fun time(text: String?): Long = WeldDate.parse(text)?.toEpochMilli() ?: 0
}

// MARK: Record chats (rules.ts)

/** One record type's group on Home. */
data class RecordGroup(
    val type: String,
    /** The top chats, or under a collapsed header only the unread ones. */
    val rows: List<RecordChat>,
    val followed: Int,
    val unread: Int,
    val mentions: Int,
    val collapsed: Boolean,
    /** "Show all (N)": the group lists fewer chats than are followed. */
    val showAll: Boolean,
)

object RecordChatRules {
    /** Record chat types, in sidebar order. */
    val types = listOf("company", "person", "task", "project", "domain", "sheet", "doc", "board")
    const val TOP_N = 5
    val quietAfter: Duration = Duration.ofDays(30)
    const val MAX_GROUP_PAGES = 4

    fun isType(type: String?): Boolean = type != null && type in types

    /** A record chat's name: the record's display name, else the channel name. */
    fun name(entityDisplayName: String?, name: String?): String =
        entityDisplayName?.takeIf { it.isNotEmpty() } ?: name.orEmpty()

    fun hasUnreadMessages(row: RecordChat): Boolean {
        val last = WeldDate.parse(row.lastMessageAt) ?: return false
        val read = WeldDate.parse(row.lastReadAt) ?: return true
        return last > read
    }

    /** Not muted, with messages after the read marker (the server's `unread`). */
    fun isUnread(row: RecordChat): Boolean = !row.isMuted && hasUnreadMessages(row)

    fun hasUnreadMentions(row: RecordChat): Boolean = row.unreadMentionCount > 0

    fun needsAttention(row: RecordChat): Boolean = hasUnreadMentions(row) || isUnread(row)

    /** No message in 30 days (or none) and nothing asking for attention. */
    fun isQuiet(row: RecordChat, now: Instant): Boolean {
        if (needsAttention(row)) return false
        val last = WeldDate.parse(row.lastMessageAt) ?: return true
        return Duration.between(last, now) > quietAfter
    }

    private fun tier(row: RecordChat): Int = when {
        hasUnreadMentions(row) -> 0
        hasUnreadMessages(row) -> 1
        else -> 2
    }

    /** Mentions first, then unread, then the rest; newest first within each. */
    fun sorted(rows: List<RecordChat>): List<RecordChat> =
        rows.sortedWith(compareBy<RecordChat> { tier(it) }.thenByDescending { DmLogic.time(it.lastMessageAt) })

    /** Home's groups: one per type with followed chats that are not all quiet. */
    fun groups(
        summary: List<RecordChatTypeSummary>?,
        rows: Map<String, List<RecordChat>>,
        isCollapsed: (String) -> Boolean,
        now: Instant,
    ): List<RecordGroup> = types.mapNotNull { type ->
        val counts = summary?.firstOrNull { it.type == type }?.takeIf { it.followed > 0 } ?: return@mapNotNull null
        val listed = sorted(rows[type].orEmpty().filter { !isQuiet(it, now) }).take(TOP_N)
        if (listed.isEmpty()) return@mapNotNull null
        val collapsed = isCollapsed(type)
        RecordGroup(
            type = type,
            rows = if (collapsed) listed.filter { hasUnreadMentions(it) || hasUnreadMessages(it) } else listed,
            followed = counts.followed,
            unread = counts.unread,
            mentions = counts.mentions,
            collapsed = collapsed,
            showAll = !collapsed && counts.followed > listed.size,
        )
    }

    /** Whether the loaded rows hold every unread chat and mention the summary counts. */
    fun coversUnread(rows: List<RecordChat>, summary: RecordChatTypeSummary): Boolean {
        val unread = rows.count { isUnread(it) }
        val mentions = rows.sumOf { it.unreadMentionCount }
        return unread >= summary.unread && mentions >= summary.mentions
    }

    /** Rows of several pages, each chat once. */
    fun uniqueRows(pages: List<List<RecordChat>>): List<RecordChat> {
        val seen = mutableSetOf<String>()
        return pages.flatten().filter { seen.add(it.id) }
    }

    /** Types whose followed, unread or mention counts differ. */
    fun changedSummaryTypes(previous: List<RecordChatTypeSummary>?, next: List<RecordChatTypeSummary>): List<String> =
        types.filter { type ->
            val a = previous?.firstOrNull { it.type == type }
            val b = next.firstOrNull { it.type == type }
            if (a == null || b == null) (a == null) != (b == null) else a.followed != b.followed || a.unread != b.unread || a.mentions != b.mentions
        }

    data class Patched(val summary: List<RecordChatTypeSummary>?, val rows: Map<String, List<RecordChat>>)

    /** The rows with one chat changed, its type's summary counts moved with it. */
    fun patch(
        summary: List<RecordChatTypeSummary>?,
        rows: Map<String, List<RecordChat>>,
        id: String,
        patch: RecordChatPatch,
        now: Instant,
    ): Patched {
        val type = types.firstOrNull { type -> rows[type].orEmpty().any { it.id == id } } ?: return Patched(summary, rows)
        val before = rows[type].orEmpty().first { it.id == id }
        var after: RecordChat? = before
        patch.isMuted?.let { muted -> after = after?.copy(isMuted = muted) }
        if (patch.markRead) after = after?.copy(lastReadAt = WeldDate.timestampString(now), unreadMentionCount = 0)
        if (patch.unfollowed) after = null
        fun counts(row: RecordChat?): Triple<Int, Int, Int> =
            if (row == null) Triple(0, 0, 0) else Triple(1, if (isUnread(row)) 1 else 0, row.unreadMentionCount)
        val a = counts(before)
        val b = counts(after)
        val nextSummary = summary?.map { entry ->
            if (entry.type != type) {
                entry
            } else {
                RecordChatTypeSummary(
                    type = entry.type,
                    followed = (entry.followed - a.first + b.first).coerceAtLeast(0),
                    unread = (entry.unread - a.second + b.second).coerceAtLeast(0),
                    mentions = (entry.mentions - a.third + b.third).coerceAtLeast(0),
                )
            }
        }
        val changed = after
        val nextRows = rows.toMutableMap()
        nextRows[type] = if (changed != null) {
            rows[type].orEmpty().map { if (it.id == id) changed else it }
        } else {
            rows[type].orEmpty().filter { it.id != id }
        }
        return Patched(nextSummary, nextRows)
    }

    enum class Refresh { ALL, SUMMARY, NONE }

    /** What a per-person realtime event means for Home's groups. */
    fun refresh(event: String?, channelId: String?, recordChatIds: Set<String>, channelIds: Set<String>): Refresh = when {
        event.isNullOrEmpty() -> Refresh.SUMMARY
        event == "channel_new" -> Refresh.ALL
        event == "dm_new" -> Refresh.NONE
        channelId != null && channelId in recordChatIds -> Refresh.ALL
        channelId != null && channelId in channelIds -> Refresh.NONE
        else -> Refresh.SUMMARY
    }

    data class AppLink(val app: String, val url: String)

    /** The app a record opens in, and its link; null without one. */
    fun appLink(type: String, entityId: String, projectId: String?): AppLink? {
        val id = pathSegment(entityId)
        return when (type) {
            "company" -> AppLink("WeldCRM", "weldcrm://company/$id")
            "person" -> AppLink("WeldCRM", "weldcrm://person/$id")
            "project" -> AppLink("WeldFlow", "weldflow://project/$id")
            "task" -> projectId?.takeIf { it.isNotEmpty() }?.let { AppLink("WeldFlow", "weldflow://task/${pathSegment(it)}/$id") }
            else -> null
        }
    }

    private fun pathSegment(text: String): String = URLEncoder.encode(text, "UTF-8").replace("+", "%20")

    /** The app name for a type, when it has one. */
    fun app(type: String): String? = when (type) {
        "company", "person" -> "WeldCRM"
        "project", "task" -> "WeldFlow"
        else -> null
    }

    /** Home's group header for a type (plural); null for an unknown type. */
    fun groupLabel(type: String): Int? = when (type) {
        "company" -> R.string.weldchat_record_chats_groups_company
        "person" -> R.string.weldchat_record_chats_groups_person
        "task" -> R.string.weldchat_record_chats_groups_task
        "project" -> R.string.weldchat_record_chats_groups_project
        "domain" -> R.string.weldchat_record_chats_groups_domain
        "sheet" -> R.string.weldchat_record_chats_groups_sheet
        "doc" -> R.string.weldchat_record_chats_groups_doc
        "board" -> R.string.weldchat_record_chats_groups_board
        else -> null
    }

    /** A type's name (singular); null for an unknown type. */
    fun typeLabel(type: String): Int? = when (type) {
        "company" -> R.string.weldchat_record_chats_types_company
        "person" -> R.string.weldchat_record_chats_types_person
        "task" -> R.string.weldchat_record_chats_types_task
        "project" -> R.string.weldchat_record_chats_types_project
        "domain" -> R.string.weldchat_record_chats_types_domain
        "sheet" -> R.string.weldchat_record_chats_types_sheet
        "doc" -> R.string.weldchat_record_chats_types_doc
        "board" -> R.string.weldchat_record_chats_types_board
        else -> null
    }
}

// MARK: Dates

object ChatDates {
    private fun daysBetween(instant: Instant, now: Instant, zone: ZoneId): Long =
        ChronoUnit.DAYS.between(instant.atZone(zone).toLocalDate(), now.atZone(zone).toLocalDate())

    private fun capitalized(text: String, locale: Locale): String =
        text.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }

    /** The day separator: Today, Yesterday, the weekday this week, then the date. */
    fun dayLabel(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): UiText {
        val days = daysBetween(instant, now, zone)
        if (days == 0L) return UiText.Res(CoreR.string.core_common_today)
        if (days == 1L) return UiText.Res(CoreR.string.core_common_yesterday)
        val date = instant.atZone(zone)
        val pattern = when {
            days in 2..6 -> "EEEE"
            date.year == now.atZone(zone).year -> "EEEE d MMMM"
            else -> "d MMMM yyyy"
        }
        return UiText.Raw(capitalized(date.format(DateTimeFormatter.ofPattern(pattern, locale)), locale))
    }

    /** A list row's time: today the time, yesterday "Yesterday", this week the weekday, else the date. */
    fun listTime(text: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): UiText {
        val instant = WeldDate.parse(text) ?: return UiText.Raw("")
        val days = daysBetween(instant, now, zone)
        val date = instant.atZone(zone)
        return when {
            days <= 0 -> UiText.Raw(date.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)))
            days == 1L -> UiText.Res(CoreR.string.core_common_yesterday)
            days < 7 -> UiText.Raw(capitalized(date.format(DateTimeFormatter.ofPattern("EEEE", locale)), locale))
            else -> UiText.Raw(date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale)))
        }
    }

    sealed interface ActivityGroup {
        data object Today : ActivityGroup
        data object Yesterday : ActivityGroup
        data object ThisWeek : ActivityGroup
        data object EarlierThisMonth : ActivityGroup
        data class Month(val month: YearMonth) : ActivityGroup
    }

    /** Activity's section for a notification. */
    fun activityGroup(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): ActivityGroup {
        val days = daysBetween(instant, now, zone)
        return when {
            days <= 0 -> ActivityGroup.Today
            days == 1L -> ActivityGroup.Yesterday
            days < 7 -> ActivityGroup.ThisWeek
            days < 30 -> ActivityGroup.EarlierThisMonth
            else -> ActivityGroup.Month(YearMonth.from(instant.atZone(zone)))
        }
    }

    fun activityGroupLabel(group: ActivityGroup, locale: Locale = Locale.getDefault()): UiText = when (group) {
        ActivityGroup.Today -> UiText.Res(CoreR.string.core_common_today)
        ActivityGroup.Yesterday -> UiText.Res(CoreR.string.core_common_yesterday)
        ActivityGroup.ThisWeek -> UiText.Res(R.string.weldchat_activity_this_week)
        ActivityGroup.EarlierThisMonth -> UiText.Res(R.string.weldchat_activity_earlier_this_month)
        is ActivityGroup.Month -> UiText.Raw(capitalized(group.month.format(DateTimeFormatter.ofPattern("LLLL yyyy", locale)), locale))
    }

    /** Activity's short time: now, 5m, 3h, 2d, else the date. */
    fun activityTime(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): UiText {
        val seconds = Duration.between(instant, now).seconds
        val minutes = (seconds / 60).toInt()
        val hours = (seconds / 3600).toInt()
        val days = (seconds / 86400).toInt()
        return when {
            minutes < 1 -> UiText.Res(R.string.weldchat_activity_now)
            minutes < 60 -> UiText.res(R.string.weldchat_activity_minutes_short, minutes)
            hours < 24 -> UiText.res(R.string.weldchat_activity_hours_short, hours)
            days < 7 -> UiText.res(R.string.weldchat_activity_days_short, days)
            else -> UiText.Raw(instant.atZone(zone).format(DateTimeFormatter.ofPattern("dd/MM", Locale.ROOT)))
        }
    }

    /** Drafts: just now, 5m ago, 3h ago, 2d ago, else the date. */
    fun draftTime(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): UiText {
        val seconds = Duration.between(instant, now).seconds
        val minutes = (seconds / 60).toInt()
        val hours = (seconds / 3600).toInt()
        val days = (seconds / 86400).toInt()
        return when {
            minutes < 1 -> UiText.Res(R.string.weldchat_drafts_just_now)
            minutes < 60 -> UiText.res(R.string.weldchat_drafts_minutes_ago, minutes)
            hours < 24 -> UiText.res(R.string.weldchat_drafts_hours_ago, hours)
            days < 7 -> UiText.res(R.string.weldchat_drafts_days_ago, days)
            else -> UiText.Raw(instant.atZone(zone).format(DateTimeFormatter.ofPattern("d MMM", locale)))
        }
    }

    /** A message's time of day. */
    fun time(instant: Instant?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        instant?.atZone(zone)?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)).orEmpty()

    /** When a thread's last reply came in, after its count: the time today, else the day ("21:45", "20 Nov"). */
    fun lastReply(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        if (sameDay(instant, now, zone)) time(instant, zone, locale) else instant.atZone(zone).format(DateTimeFormatter.ofPattern("d MMM", locale))

    /** Whether two instants fall on the same day on the phone's calendar. */
    fun sameDay(a: Instant, b: Instant, zone: ZoneId = ZoneId.systemDefault()): Boolean =
        a.atZone(zone).toLocalDate() == b.atZone(zone).toLocalDate()

    /** A day as the key of a group. */
    fun day(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): LocalDate = instant.atZone(zone).toLocalDate()
}

// MARK: Search

enum class SearchTab(val key: String, val label: Int) {
    ALL("all", R.string.weldchat_search_tabs_all),
    PEOPLE("people", R.string.weldchat_search_tabs_people),
    PHOTOS("photos", R.string.weldchat_search_tabs_photos),
    VIDEOS("videos", R.string.weldchat_search_tabs_videos),
    LINKS("links", R.string.weldchat_search_tabs_links),
    GIFS("gifs", R.string.weldchat_search_tabs_gifs),
    AUDIO("audio", R.string.weldchat_search_tabs_audio),
    DOCS("docs", R.string.weldchat_search_tabs_docs),
    ;

    /** Whether a message result belongs to this category (attachments, or a URL for links). */
    fun matches(hit: SearchHitItem): Boolean {
        val types = hit.attachments.map { it.mimeType.lowercase() }
        return when (this) {
            ALL, PEOPLE -> true
            LINKS -> Regex("https?://", RegexOption.IGNORE_CASE).containsMatchIn(hit.content)
            PHOTOS -> types.any { it.startsWith("image/") && it != "image/gif" }
            GIFS -> "image/gif" in types
            VIDEOS -> types.any { it.startsWith("video/") }
            AUDIO -> types.any { it.startsWith("audio/") }
            DOCS -> types.any { it.isNotEmpty() && !it.startsWith("image/") && !it.startsWith("video/") && !it.startsWith("audio/") }
        }
    }
}

object RecentSearches {
    const val LIMIT = 8

    /** The term first, without duplicates, at most [LIMIT]. */
    fun adding(term: String, list: List<String>): List<String> {
        val trimmed = term.trim()
        if (trimmed.isEmpty()) return list
        return (listOf(trimmed) + list.filter { it != trimmed }).take(LIMIT)
    }
}

// MARK: Channel names

object ChannelNames {
    /** Slack's limit. */
    const val MAX_LENGTH = 80

    /** Lowercase words joined by dashes, as the platform names channels. */
    fun normalize(text: String): String = text.lowercase()
        .replace(Regex("\\s+"), "-")
        .replace(Regex("[^a-z0-9_-]"), "")
        .replace(Regex("-{2,}"), "-")
        .take(MAX_LENGTH)

    /** Without dashes at either end: "-marketing-" is "marketing". */
    fun trimDashes(name: String): String = name.trim('-')
}

// MARK: Pins

enum class PinDuration(val key: String, val label: Int, private val length: Duration?) {
    DAY("day", R.string.weldchat_channel_pin24h, Duration.ofHours(24)),
    WEEK("week", R.string.weldchat_channel_pin7d, Duration.ofDays(7)),
    MONTH("month", R.string.weldchat_channel_pin30d, Duration.ofDays(30)),
    FOREVER("forever", R.string.weldchat_channel_pin_always, null),
    ;

    /** When the pin goes; null pins for good. */
    fun expiresAt(now: Instant = Instant.now()): Instant? = length?.let { now.plus(it) }
}

// MARK: Agents

object AgentVisuals {
    val kinds = setOf("chart", "stats", "table", "records")

    fun line(visual: AgentVisualRef): UiText {
        val kind = when (visual.kind) {
            "chart" -> R.string.weldchat_channel_visual_kinds_chart
            "stats" -> R.string.weldchat_channel_visual_kinds_stats
            "table" -> R.string.weldchat_channel_visual_kinds_table
            else -> R.string.weldchat_channel_visual_kinds_records
        }
        return UiText.res(R.string.weldchat_channel_visual_shown, UiText.Res(kind), visual.title)
    }
}

// MARK: Members

object MemberLogic {
    /** "Owner", "Admin", … as the platform's role label. */
    fun roleLabel(role: String): Int = when (role) {
        "OWNER" -> R.string.weldchat_member_roles_owner
        "ADMIN" -> R.string.weldchat_member_roles_admin
        "MEMBER" -> R.string.weldchat_member_roles_member
        "VIEWER" -> R.string.weldchat_member_roles_viewer
        else -> if (role.startsWith("role_")) R.string.weldchat_member_roles_custom else R.string.weldchat_member_roles_member
    }

    fun weekdayLabel(day: Weekday): Int = when (day) {
        Weekday.MONDAY -> R.string.weldchat_member_weekdays_monday
        Weekday.TUESDAY -> R.string.weldchat_member_weekdays_tuesday
        Weekday.WEDNESDAY -> R.string.weldchat_member_weekdays_wednesday
        Weekday.THURSDAY -> R.string.weldchat_member_weekdays_thursday
        Weekday.FRIDAY -> R.string.weldchat_member_weekdays_friday
        Weekday.SATURDAY -> R.string.weldchat_member_weekdays_saturday
        Weekday.SUNDAY -> R.string.weldchat_member_weekdays_sunday
    }

    private fun zone(timezone: String): ZoneId? = runCatching { ZoneId.of(timezone) }.getOrNull()

    /** The local time in a timezone, "14:05"; a dash for an unknown zone. */
    fun localTime(now: Instant, timezone: String): String {
        val zone = zone(timezone) ?: return "—"
        return now.atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT))
    }

    /** "GMT+1" for a timezone; empty for an unknown one. */
    fun offset(now: Instant, timezone: String): String {
        val zone = zone(timezone) ?: return ""
        val seconds = zone.rules.getOffset(now).totalSeconds
        if (seconds == 0) return "GMT"
        val hours = seconds / 3600
        val minutes = abs(seconds % 3600) / 60
        val sign = if (seconds < 0) "-" else "+"
        return if (minutes == 0) "GMT$sign${abs(hours)}" else "GMT$sign${abs(hours)}:%02d".format(Locale.ROOT, minutes)
    }

    /** Hours per week as the API takes it; null for something that isn't a number. */
    fun parseHours(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()

    /** `created 'Q3 plan'` → "Q3 plan". */
    fun quotedName(description: String): String? =
        ChatLogic.firstMatch("'([^']+)'", description) ?: ChatLogic.firstMatch("\"([^\"]+)\"", description)

    /** `project_task` → "Project task"; `statusChanged` → "Status changed". */
    fun sentenceCase(raw: String): String {
        val words = raw.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
            .replace(Regex("[_-]"), " ")
            .trim()
            .lowercase()
        return words.replaceFirstChar { it.uppercase() }
    }

    fun entityTypeLabel(entityType: String): String {
        val last = entityType.lowercase().split('_', '-').lastOrNull { it.isNotEmpty() } ?: entityType
        return sentenceCase(last)
    }

    fun actionLabel(action: String): UiText = when (action) {
        "created" -> UiText.Res(R.string.weldchat_member_activity_actions_created)
        "updated" -> UiText.Res(R.string.weldchat_member_activity_actions_updated)
        "deleted" -> UiText.Res(R.string.weldchat_member_activity_actions_deleted)
        "archived" -> UiText.Res(R.string.weldchat_member_activity_actions_archived)
        "status_changed" -> UiText.Res(R.string.weldchat_member_activity_actions_status_changed)
        "assigned" -> UiText.Res(R.string.weldchat_member_activity_actions_assigned)
        "escalated" -> UiText.Res(R.string.weldchat_member_activity_actions_escalated)
        "priority_changed" -> UiText.Res(R.string.weldchat_member_activity_actions_priority_changed)
        "added" -> UiText.Res(R.string.weldchat_member_activity_actions_added)
        "removed" -> UiText.Res(R.string.weldchat_member_activity_actions_removed)
        else -> UiText.Raw(sentenceCase(action).lowercase())
    }

    /** One record of a timeline event: named records get a card each. */
    data class RecordCard(val id: String, val title: String, val recordCount: Int, val entryCount: Int, val named: Boolean)

    /** "Ann created 4 × Project": entries grouped by action and record type. */
    data class TimelineEvent(
        val id: String,
        val action: String,
        val entityType: String,
        val cards: List<RecordCard>,
        val latest: MemberActivityEntry,
        val recordCount: Int,
        val entryCount: Int,
    )

    data class Day(val id: String, val date: LocalDate, val events: List<TimelineEvent>)

    /** The days of a member's activity, newest first, each a list of events. */
    fun timeline(entries: List<MemberActivityEntry>, zone: ZoneId = ZoneId.systemDefault()): List<Day> {
        val names = mutableMapOf<String, String>()
        for (entry in entries) {
            if (entry.entityId !in names) quotedName(entry.description)?.let { names[entry.entityId] = it }
        }
        val byDay = linkedMapOf<LocalDate, MutableList<MemberActivityEntry>>()
        for (entry in entries) {
            val instant = WeldDate.parse(entry.createdAt) ?: continue
            byDay.getOrPut(instant.atZone(zone).toLocalDate()) { mutableListOf() }.add(entry)
        }
        return byDay.map { (date, dayEntries) -> Day(date.toString(), date, events(dayEntries, names)) }
            .sortedByDescending { it.date }
    }

    fun events(entries: List<MemberActivityEntry>, names: Map<String, String>): List<TimelineEvent> {
        val events = mutableListOf<TimelineEvent>()
        val cardIds = mutableMapOf<String, MutableMap<String, MutableSet<String>>>()
        val eventIds = mutableMapOf<String, MutableSet<String>>()
        for (entry in entries) {
            val key = "${entry.action}:${entry.entityType}"
            var index = events.indexOfFirst { it.id == key }
            if (index < 0) {
                events.add(TimelineEvent(key, entry.action, entry.entityType, emptyList(), entry, 0, 0))
                index = events.lastIndex
            }
            val name = names[entry.entityId]
            val cardKey = if (name == null) "unnamed" else entry.entityId
            var event = events[index]
            if (event.cards.none { it.id == cardKey }) {
                event = event.copy(cards = event.cards + RecordCard(cardKey, name ?: entityTypeLabel(entry.entityType), 0, 0, name != null))
            }
            cardIds.getOrPut(key) { mutableMapOf() }.getOrPut(cardKey) { mutableSetOf() }.add(entry.entityId)
            eventIds.getOrPut(key) { mutableSetOf() }.add(entry.entityId)
            val records = cardIds[key]?.get(cardKey)?.size ?: 0
            event = event.copy(
                cards = event.cards.map { if (it.id == cardKey) it.copy(entryCount = it.entryCount + 1, recordCount = records) else it },
                recordCount = eventIds[key]?.size ?: 0,
                entryCount = event.entryCount + 1,
            )
            events[index] = event
        }
        return events
    }

    /** The presence dot's colour (`0xRRGGBB`), as the platform's status dot. */
    fun presenceColor(status: PresenceStatus): Long = when (status) {
        PresenceStatus.ONLINE -> 0x22C55E
        PresenceStatus.BUSY -> 0xF97316
        PresenceStatus.DND -> 0xEF4444
        PresenceStatus.AWAY -> 0xEAB308
        PresenceStatus.OFFLINE -> 0x9CA3AF
    }
}

// MARK: Push

/** Where a tapped notification leads (`NotificationContext`). */
sealed interface PushRoute {
    data object IncomingCall : PushRoute
    data class Conversation(val channelId: String, val isDm: Boolean) : PushRoute
    data object None : PushRoute

    companion object {
        fun of(values: Map<String, String>): PushRoute {
            val type = values["notificationType"]
            if (type == "chat_incoming_call" || type == "chat_call_ring") return IncomingCall
            if (type == "push_test") return None
            val fromUrl = ChatLogic.conversationFromActionUrl(values["actionUrl"])
            if (type == "chat_missed_call") return fromUrl?.let { Conversation(it.channelId, true) } ?: None
            val channelId = values["chatChannelId"]?.takeIf { it.isNotEmpty() }
                ?: values["channelId"]?.takeIf { it.isNotEmpty() }
                ?: fromUrl?.channelId
                ?: return None
            return Conversation(channelId, values["actionUrl"]?.contains("/dm/") == true)
        }
    }
}

/** `weldchat://…` links, as the Expo app's router answered them. */
sealed interface DeepLink {
    data class Channel(val id: String) : DeepLink
    data class Dm(val id: String) : DeepLink
    data class User(val id: String) : DeepLink
    data class Thread(val messageId: String, val channelId: String) : DeepLink
    data object Search : DeepLink
    data object Records : DeepLink
    data object Drafts : DeepLink
    data object Saved : DeepLink
    data object Settings : DeepLink

    companion object {
        fun parse(url: String?): DeepLink? {
            val uri = url?.let { runCatching { URI(it) }.getOrNull() } ?: return null
            if (uri.scheme != "weldchat") return null
            val host = uri.host ?: return null
            val first = uri.rawPath.orEmpty().split('/').firstOrNull { it.isNotEmpty() }?.let { URLDecoder.decode(it, "UTF-8") }
            val query = uri.rawQuery.orEmpty().split('&').mapNotNull { part ->
                val pieces = part.split('=', limit = 2)
                if (pieces.size == 2) URLDecoder.decode(pieces[0], "UTF-8") to URLDecoder.decode(pieces[1], "UTF-8") else null
            }.toMap()
            return when (host) {
                "channel" -> first?.let { Channel(it) }
                "dm" -> first?.let { Dm(it) }
                "user" -> first?.let { User(it) }
                "thread" -> {
                    val channel = query["channelId"]
                    if (first != null && channel != null) Thread(first, channel) else null
                }
                "search" -> Search
                "records" -> Records
                "drafts" -> Drafts
                "later" -> Saved
                "settings" -> Settings
                else -> null
            }
        }
    }
}

// MARK: Voice messages

object Waveform {
    const val BAR_COUNT = 33

    /** `31 * h + code`, wrapped to 32 bits, as the Expo app hashes the URL. */
    fun hash(text: String): Int {
        var h = 0
        for (char in text) h = 31 * h + char.code
        return h
    }

    /** Bar heights (0.25…1) from a seed, the same every time for one message. */
    fun bars(seed: Int, count: Int = BAR_COUNT): List<Double> {
        var s = seed.toUInt()
        if (s == 0u) s = 1u
        return List(count) { i ->
            s = s xor (s shl 13)
            s = s xor (s shr 17)
            s = s xor (s shl 5)
            val v = (s % 1000u).toDouble() / 1000
            val envelope = 0.5 + 0.5 * sin(i.toDouble() / count * PI)
            0.25 + 0.75 * v * envelope
        }
    }

    /** The share of bars played at a playback position (0…1). */
    fun progress(positionMs: Long, durationMs: Long): Float =
        if (durationMs <= 0) 0f else (positionMs.toFloat() / durationMs).coerceIn(0f, 1f)

    /** Rounded percentage, for accessibility. */
    fun percent(fraction: Float): Int = (fraction * 100).roundToInt()
}
