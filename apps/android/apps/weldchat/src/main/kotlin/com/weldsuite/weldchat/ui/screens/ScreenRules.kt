package com.weldsuite.weldchat.ui.screens

import android.content.SharedPreferences
import androidx.core.content.edit
import com.weldsuite.weldchat.ChatBookmark
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.CommonConceptsInfo
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.DayHoursInfo
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.DmLogic
import com.weldsuite.weldchat.DmPerson
import com.weldsuite.weldchat.MemberLogic
import com.weldsuite.weldchat.MemberPresence
import com.weldsuite.weldchat.MemberProfileInfo
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecentSearches
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.RecordChatRules
import com.weldsuite.weldchat.SearchHitItem
import com.weldsuite.weldchat.SearchTab
import com.weldsuite.weldchat.TeamMember
import com.weldsuite.weldchat.UiText
import com.weldsuite.weldchat.Weekday
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import org.weldsuite.core.WeldDate
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.weldsuite.core.R as CoreR

// The rules of the list and create screens (drafts, saved, record chats,
// search, a member, new channel / DM / message), without the screens. Pure,
// so ScreenRulesTest covers them. The same rules as the iOS app's
// Screens/ScreenRules.swift.

// MARK: Drafts and saved

/** A draft as the Drafts screen lists it, with its conversation's name. */
data class DraftItem(
    val id: String,
    val channelId: String,
    val channelName: String,
    val isDm: Boolean,
    val content: String,
    val updatedAt: String,
)

/** A conversation the app already knows: its name and whether it is a DM. */
data class KnownConversation(val name: String, val isDm: Boolean)

object SavedRules {
    /** The conversation a draft or a saved message is in: `#name` for a channel, the name for a DM. */
    fun conversationLabel(name: String, isDm: Boolean): String = if (isDm) name else "#$name"

    /** Newest first. */
    fun sortedDrafts(drafts: List<DraftItem>): List<DraftItem> = drafts.sortedByDescending { DmLogic.time(it.updatedAt) }

    /**
     * A draft's conversation, from what the app already has: a DM's display
     * name, or a channel's name and type. Null when neither list has it.
     */
    fun knownConversation(channelId: String, dms: List<DmConversation>, channels: List<ChatChannel>): KnownConversation? {
        dms.firstOrNull { it.id == channelId }?.let { return KnownConversation(it.name, true) }
        channels.firstOrNull { it.id == channelId }?.let { return KnownConversation(it.name, it.isDm) }
        return null
    }

    /**
     * A saved message's conversation name: a DM goes by its people, as the
     * DM list names it; else the bookmark's own channel name.
     */
    fun bookmarkConversation(bookmark: ChatBookmark, dms: List<DmConversation>): UiText {
        if (bookmark.channelType == "dm") dms.firstOrNull { it.id == bookmark.channelId }?.let { return UiText.Raw(it.name) }
        bookmark.channelName?.takeIf { it.isNotEmpty() }?.let { return UiText.Raw(it) }
        return UiText.Res(R.string.weldchat_saved_unknown_channel)
    }

    /** The saved message's text in one preview: mentions as names, files dropped. */
    fun bookmarkText(bookmark: ChatBookmark, names: Map<String, String>): UiText {
        val content = bookmark.messageContent ?: return UiText.Res(R.string.weldchat_saved_unavailable)
        return UiText.Raw(MentionText.plainText(content, names).trim())
    }
}

// MARK: Record chats

enum class RecordsFilter(val wire: String, val label: Int) {
    FOLLOWING("following", R.string.weldchat_record_chats_filters_following),
    UNREAD("unread", R.string.weldchat_record_chats_filters_unread),
    MENTIONS("mentions", R.string.weldchat_record_chats_filters_mentions),
    ALL("all", R.string.weldchat_record_chats_filters_all),
}

object RecordsRules {
    const val PAGE_SIZE = 25

    /** The pause after typing before the search runs. */
    const val SEARCH_DEBOUNCE_MS = 300L

    /** A busy chat sends an event per message: the list reloads once per burst. */
    const val EVENT_BURST_MS = 400L

    /** What the empty list says: the search, else the filter. */
    fun emptyText(filter: RecordsFilter, search: String): UiText {
        if (search.isNotEmpty()) return UiText.res(R.string.weldchat_record_chats_empty_search, search)
        return UiText.Res(
            when (filter) {
                RecordsFilter.FOLLOWING -> R.string.weldchat_record_chats_empty_following
                RecordsFilter.UNREAD -> R.string.weldchat_record_chats_empty_unread
                RecordsFilter.MENTIONS -> R.string.weldchat_record_chats_empty_mentions
                RecordsFilter.ALL -> R.string.weldchat_record_chats_empty_all
            },
        )
    }

    /** The type a link or Home's "Show all" asks for, when it is one. */
    fun initialType(type: String?): String? = type?.takeIf { RecordChatRules.isType(it) }

    /**
     * A change from a row's menu or swipe, shown at once. Unfollowing drops
     * the row unless the filter is All (only All lists chats you don't follow).
     */
    fun apply(patch: ConversationPatch, rows: List<RecordChat>, id: String, filter: RecordsFilter, now: Instant): List<RecordChat> =
        rows.mapNotNull { row ->
            if (row.id != id) return@mapNotNull row
            var next = row
            patch.isMuted?.let { next = next.copy(isMuted = it) }
            if (patch.hasUnread == false) next = next.copy(lastReadAt = WeldDate.timestampString(now), unreadMentionCount = 0)
            val following = patch.isFollowing
            if (following != null) {
                next = next.copy(isFollowing = following)
                if (!following && filter != RecordsFilter.ALL) return@mapNotNull null
            }
            next
        }

    /** A change that needs the server's list: undoing a mark-read, or a follow put back on a row that already left. */
    fun needsReload(patch: ConversationPatch, rowListed: Boolean): Boolean =
        patch.hasUnread == true || (patch.isFollowing == true && !rowListed)

    /** Bold when followed and asking for attention. */
    fun isHighlighted(chat: RecordChat): Boolean =
        chat.isFollowing && (RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat))

    /** The row's second line: the preview, after the record's type when the list shows every type. */
    fun subtitle(chat: RecordChat, showType: Boolean): UiText {
        val preview = chat.lastMessagePreview?.takeIf { it.isNotEmpty() }?.let { UiText.Raw(it) }
            ?: UiText.Res(R.string.weldchat_record_chats_no_messages)
        val type = RecordChatRules.typeLabel(chat.entityType)
        if (!showType || type == null) return preview
        return UiText.res(R.string.weldchat_record_chats_type_and_preview, UiText.Res(type), preview)
    }

    /** Whether a personal event is about the list: a new chat, or one it shows. */
    fun isRelevant(event: String, channelId: String?, rows: List<RecordChat>): Boolean {
        if (event == "channel_new") return true
        if (channelId == null) return false
        return rows.any { it.id == channelId }
    }
}

// MARK: Search

object SearchRules {
    /** The pause after typing before the search runs. */
    const val DEBOUNCE_MS = 400L

    /** People whose name or e-mail holds the text, case-insensitively. */
    fun people(roster: List<TeamMember>, text: String): List<TeamMember> {
        val needle = text.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return roster.filter { matches(it, needle) }
    }

    /** The results a tab shows: People has none, the rest filter the messages. */
    fun results(hits: List<SearchHitItem>, tab: SearchTab): List<SearchHitItem> =
        if (tab == SearchTab.PEOPLE) emptyList() else hits.filter { tab.matches(it) }

    /** The attachment line of a result: the first file's name, else its type. */
    fun attachmentLabel(hit: SearchHitItem): UiText? {
        val first = hit.attachments.firstOrNull() ?: return null
        if (first.fileName.isNotEmpty()) return UiText.Raw(first.fileName)
        return if (first.mimeType.isEmpty()) UiText.Res(R.string.weldchat_channel_attachment) else UiText.Raw(first.mimeType)
    }

    /** A member whose name or e-mail holds [needle] (already lowercased). */
    internal fun matches(member: TeamMember, needle: String): Boolean =
        member.name?.lowercase()?.contains(needle) == true || member.email?.lowercase()?.contains(needle) == true
}

/** The last searches, kept on the device as the Expo app kept them (a JSON list of strings). */
object RecentSearchStore {
    const val KEY = "weldchat.recentSearches"
    const val PREFERENCES = "weldchat"

    fun decode(text: String?): List<String> {
        if (text.isNullOrEmpty()) return emptyList()
        return runCatching { WeldJson.decodeFromString(ListSerializer(String.serializer()), text) }
            .getOrDefault(emptyList())
            .take(RecentSearches.LIMIT)
    }

    fun encode(list: List<String>): String = WeldJson.encodeToString(ListSerializer(String.serializer()), list)

    fun load(preferences: SharedPreferences): List<String> = decode(preferences.getString(KEY, null))

    fun save(preferences: SharedPreferences, list: List<String>) {
        preferences.edit {
            if (list.isEmpty()) remove(KEY) else putString(KEY, encode(list))
        }
    }
}

// MARK: A member

enum class MemberTab(val key: String, val label: Int) {
    OVERVIEW("overview", R.string.weldchat_member_tabs_overview),
    COMMON("common", R.string.weldchat_member_tabs_common),
    ACTIVITY("activity", R.string.weldchat_member_tabs_activity),
}

enum class MemberLoadState { LOADING, READY, NOT_FOUND, FAILED }

/** The icon a timeline record type gets (the screen maps it to a vector). */
enum class EntityIcon { TASK, TAG, PERSON, COMPANY, DEAL, TICKET, EMAIL, CALENDAR, DOCUMENT, ORDER, PRODUCT, FOLDER, OTHER }

object MemberScreenRules {
    const val NOTE_LIMIT = 1500

    /** The pause after typing before the private note saves. */
    const val NOTE_SAVE_DELAY_MS = 600L

    /** The header: the person's name, or what went wrong loading them. */
    fun headerName(profile: MemberProfileInfo?, state: MemberLoadState): UiText {
        if (profile != null) {
            profile.name?.takeIf { it.isNotEmpty() }?.let { return UiText.Raw(it) }
            profile.email?.takeIf { it.isNotEmpty() }?.let { return UiText.Raw(it) }
            return UiText.Res(R.string.weldchat_member_fallback_name)
        }
        return when (state) {
            MemberLoadState.NOT_FOUND -> UiText.Res(R.string.weldchat_member_not_found_title)
            MemberLoadState.FAILED -> UiText.Res(R.string.weldchat_member_profile_load_failed_title)
            MemberLoadState.LOADING, MemberLoadState.READY -> UiText.Raw("")
        }
    }

    /** The custom status under the name: emoji and text, when either is set. */
    fun customStatus(presence: MemberPresence?): String? {
        if (presence == null || (presence.statusText == null && presence.statusEmoji == null)) return null
        val text = "${presence.statusEmoji.orEmpty()} ${presence.statusText.orEmpty()}".trim()
        return text.ifEmpty { null }
    }

    /** Nothing is "in common" with yourself, so that tab is left out. */
    fun tabs(isSelf: Boolean): List<MemberTab> =
        if (isSelf) listOf(MemberTab.OVERVIEW, MemberTab.ACTIVITY) else listOf(MemberTab.OVERVIEW, MemberTab.COMMON, MemberTab.ACTIVITY)

    /** The week, when at least one day is a working day. */
    fun schedule(hours: Map<Weekday, DayHoursInfo>): List<Pair<Weekday, DayHoursInfo?>>? {
        if (Weekday.entries.none { hours[it]?.isOpen == true }) return null
        return Weekday.entries.map { it to hours[it] }
    }

    /** "09:00 – 17:00  (1 break 12:00–12:30)", or "Not working"; [text] turns a [UiText] into words. */
    fun dayHours(hours: DayHoursInfo?, text: (UiText) -> String): String {
        if (hours == null || !hours.isOpen) return text(UiText.Res(R.string.weldchat_member_not_working))
        val range = text(UiText.res(R.string.weldchat_member_hours_range, hours.openTime ?: "—", hours.closeTime ?: "—"))
        if (hours.breaks.isEmpty()) return range
        val breaks = hours.breaks.joinToString(", ") { "${it.start}–${it.end}" }
        return "$range  (${text(UiText.Plural(R.plurals.weldchat_member_breaks, hours.breaks.size))} $breaks)"
    }

    /** The edited value as the API takes it; null when nothing changed. */
    fun commit(draft: String, previous: String?): String? {
        val next = draft.trim()
        return if (next == previous.orEmpty().trim()) null else next
    }

    /** "in progress" → "In Progress", as the platform's hints read. */
    fun capitalizeWords(text: String): String {
        val out = StringBuilder()
        var atWordStart = true
        for (character in text) {
            val isWordCharacter = character.isLetterOrDigit() || character == '_'
            if (atWordStart && isWordCharacter) out.append(character.uppercase()) else out.append(character)
            atWordStart = !isWordCharacter
        }
        return out.toString()
    }

    /** A task's hint: its status, and "delegated" when it is. */
    fun taskHint(task: CommonConceptsInfo.Task): UiText =
        if (task.role == "delegated") UiText.res(R.string.weldchat_member_common_delegated, task.status) else UiText.Raw(task.status)

    /** A shared conversation's name: `# name` for a channel, the name for a DM. */
    fun commonChannelLabel(channel: CommonConceptsInfo.Channel): String = if (channel.type == "dm") channel.name else "# ${channel.name}"

    fun commonCount(info: CommonConceptsInfo): Int =
        info.channels.size + info.projects.size + info.tasks.size + info.crm.size + info.helpdesk.size

    /** A timeline day: Today, Yesterday, else "Monday, March 2". */
    fun dayLabel(date: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): UiText = when (date) {
        today -> UiText.Res(CoreR.string.core_common_today)
        today.minusDays(1) -> UiText.Res(CoreR.string.core_common_yesterday)
        else -> {
            val text = date.format(DateTimeFormatter.ofPattern("EEEE, MMMM d", locale))
            UiText.Raw(text.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() })
        }
    }

    /** An event's time: "just now", "5 min ago", "3h ago" today, else "14:05". */
    fun eventTime(instant: Instant, now: Instant, zone: ZoneId = ZoneId.systemDefault()): UiText {
        if (instant.atZone(zone).toLocalDate() != now.atZone(zone).toLocalDate()) {
            return UiText.Raw(instant.atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)))
        }
        val minutes = Duration.between(instant, now).toMinutes().toInt()
        return when {
            minutes < 1 -> UiText.Res(R.string.weldchat_member_activity_just_now)
            minutes < 60 -> UiText.res(R.string.weldchat_member_activity_minutes_ago, minutes)
            else -> UiText.res(R.string.weldchat_member_activity_hours_ago, minutes / 60)
        }
    }

    /** "4 × Project", or the type alone for one record. */
    fun what(event: MemberLogic.TimelineEvent): UiText {
        val type = MemberLogic.entityTypeLabel(event.entityType)
        return if (event.recordCount > 1) UiText.res(R.string.weldchat_member_activity_many, event.recordCount, type) else UiText.Raw(type)
    }

    /** "Ann created 4 × Project", or without the name; [action] is the action's label in lower case. */
    fun sentence(event: MemberLogic.TimelineEvent, memberName: String?, action: String): UiText =
        if (!memberName.isNullOrEmpty()) {
            UiText.res(R.string.weldchat_member_activity_sentence, memberName, action, what(event))
        } else {
            UiText.res(R.string.weldchat_member_activity_sentence_no_name, action, what(event))
        }

    /** The record cards worth showing: the named ones (an unnamed card would only repeat the sentence). */
    fun cards(event: MemberLogic.TimelineEvent): List<MemberLogic.RecordCard> = event.cards.filter { it.named }

    /** "×N" after the sentence: the same records touched more than once, with no card to say so. */
    fun eventRepeats(event: MemberLogic.TimelineEvent): Int? =
        if (cards(event).isEmpty() && event.entryCount > event.recordCount) event.entryCount else null

    /** The chip on a card: several records, or one record touched several times. */
    fun cardCount(card: MemberLogic.RecordCard): Int? {
        if (card.recordCount > 1) return card.recordCount
        val repeats = card.entryCount / maxOf(card.recordCount, 1)
        return if (repeats > 1) repeats else null
    }

    /** The icon for a timeline record type, matched on a keyword (`project_task` is a task, so project comes last). */
    fun entityIcon(entityType: String): EntityIcon {
        val key = entityType.lowercase()
        val table = listOf(
            listOf("task", "checklist") to EntityIcon.TASK,
            listOf("label", "tag") to EntityIcon.TAG,
            listOf("member", "user", "person", "contact", "customer") to EntityIcon.PERSON,
            listOf("company", "account", "organization") to EntityIcon.COMPANY,
            listOf("deal", "opportunity", "lead") to EntityIcon.DEAL,
            listOf("ticket", "conversation") to EntityIcon.TICKET,
            listOf("email", "message") to EntityIcon.EMAIL,
            listOf("meeting", "session", "event") to EntityIcon.CALENDAR,
            listOf("page", "document", "note") to EntityIcon.DOCUMENT,
            listOf("order") to EntityIcon.ORDER,
            listOf("product") to EntityIcon.PRODUCT,
            listOf("project") to EntityIcon.FOLDER,
        )
        return table.firstOrNull { (keywords, _) -> keywords.any { key.contains(it) } }?.second ?: EntityIcon.OTHER
    }

    /** "Europe/Amsterdam · 14:05 (GMT+1)". */
    fun zoneLine(zone: String, now: Instant): String {
        val offset = MemberLogic.offset(now, zone)
        val time = MemberLogic.localTime(now, zone)
        return if (offset.isEmpty()) "$zone · $time" else "$zone · $time ($offset)"
    }
}

// MARK: New channel, new DM

object NewChannelRules {
    /** Step 0 the name, 1 public or private and the category, 2 the people of a private channel. */
    fun lastStep(isPrivate: Boolean): Int = if (isPrivate) 2 else 1

    /** The name sent: without dashes at either end. */
    fun finalName(name: String): String = com.weldsuite.weldchat.ChannelNames.trimDashes(name)

    fun canContinue(step: Int, name: String, creating: Boolean): Boolean =
        if (step == 0) finalName(name).isNotEmpty() else !creating

    /** Next, then Create, or "Create (3)" with people picked for a private channel. */
    fun primaryLabel(step: Int, isPrivate: Boolean, selectedCount: Int): UiText {
        if (step != lastStep(isPrivate)) return UiText.Res(R.string.weldchat_new_channel_next)
        return if (isPrivate && selectedCount > 0) {
            UiText.res(R.string.weldchat_new_channel_create_with_count, selectedCount)
        } else {
            UiText.Res(R.string.weldchat_new_channel_create)
        }
    }

    fun title(step: Int): Int = when (step) {
        1 -> R.string.weldchat_new_channel_visibility_label
        2 -> R.string.weldchat_new_channel_people_title
        else -> R.string.weldchat_new_channel_title
    }

    /** Everyone but the caller, matched on name or e-mail. */
    fun people(roster: List<TeamMember>, selfId: String, query: String): List<TeamMember> {
        val others = roster.filter { it.userId != selfId }
        val needle = query.trim().lowercase()
        return if (needle.isEmpty()) others else others.filter { SearchRules.matches(it, needle) }
    }

    /** A name that is taken comes back as 409: the name has to change. */
    fun isNameTaken(error: Throwable): Boolean = (error as? ApiException)?.status == 409
}

object NewDmRules {
    /** A group needs at least two people. */
    fun minimum(isGroup: Boolean): Int = if (isGroup) 2 else 1

    /**
     * Everyone but the caller and invitees who haven't joined (chat-api
     * refuses a DM before then), matched on name or e-mail.
     */
    fun people(roster: List<TeamMember>, selfId: String, query: String): List<TeamMember> {
        val others = roster.filter { it.userId != selfId && !it.isPendingInvitee }
        val needle = query.trim().lowercase()
        return if (needle.isEmpty()) others else others.filter { SearchRules.matches(it, needle) }
    }

    fun startLabel(selectedCount: Int): UiText =
        if (selectedCount > 1) UiText.res(R.string.weldchat_new_message_start_with_count, selectedCount) else UiText.Res(R.string.weldchat_new_message_start)

    fun toggled(selected: List<String>, userId: String): List<String> =
        if (userId in selected) selected.filter { it != userId } else selected + userId
}

// MARK: New message

/** Who a new message goes to: a channel, an existing (group) DM, or a person. */
sealed interface MessageRecipient {
    /** `channel:<id>`, `dm:<id>` or `p:<userId>`: the key of a chip and a row. */
    val key: String
    val name: String

    data class Channel(val id: String, override val name: String, val isPrivate: Boolean) : MessageRecipient {
        override val key: String get() = "channel:$id"
    }

    data class Dm(val id: String, override val name: String, val people: List<DmPerson>) : MessageRecipient {
        override val key: String get() = "dm:$id"
    }

    data class Person(val userId: String, override val name: String, val picture: String?) : MessageRecipient {
        override val key: String get() = "p:$userId"
    }

    /** How the chip and the row read it: `#name` for a channel. */
    val label: String get() = if (this is Channel) "#$name" else name
}

/** A conversation the new message goes to: its id, whether it is a DM, and its recipient's key. */
data class Destination(val id: String, val isDm: Boolean, val key: String)

/** Where a new message goes: each channel and conversation, and one DM for all the [people]. */
data class DeliveryPlan(val conversations: List<Destination>, val people: List<String>)

object NewMessageRules {
    const val RECENT_COUNT = 10
    const val RESULT_COUNT = 20

    fun recipient(channel: ChatChannel): MessageRecipient = MessageRecipient.Channel(channel.id, channel.name, channel.isPrivate)

    fun recipient(member: TeamMember): MessageRecipient = MessageRecipient.Person(member.userId, member.name ?: member.email ?: "?", member.picture)

    /** A 1:1 DM is its person; a group DM stays a conversation. */
    fun recipient(dm: DmConversation): MessageRecipient {
        val peer = dm.otherMembers.firstOrNull()
        if (!dm.isGroup && peer != null) return MessageRecipient.Person(peer.userId, peer.name ?: peer.email ?: dm.name, peer.picture)
        return MessageRecipient.Dm(dm.id, dm.name, dm.otherMembers)
    }

    /** The latest conversations, DMs and channels together; equal times keep DMs first. */
    fun recent(channels: List<ChatChannel>, dms: List<DmConversation>): List<MessageRecipient> {
        val items = dms.map { DmLogic.time(it.lastMessageAt) to recipient(it) } +
            channels.map { DmLogic.time(it.lastMessageAt) to recipient(it) }
        return items.sortedByDescending { it.first }.take(RECENT_COUNT).map { it.second }
    }

    /** The query without a leading `#` or `@`, lowercased. */
    fun term(query: String): String {
        val text = query.trim()
        return (if (text.startsWith("#") || text.startsWith("@")) text.drop(1) else text).lowercase()
    }

    /**
     * Searching: the people that match. Otherwise everyone not already in
     * Recent, by name. Never the caller or an invitee who hasn't joined.
     */
    fun people(roster: List<TeamMember>, selfId: String, query: String, recent: List<MessageRecipient>): List<MessageRecipient> {
        val others = roster.filter { it.userId != selfId && !it.isPendingInvitee }
        val needle = term(query)
        if (needle.isNotEmpty()) return others.filter { SearchRules.matches(it, needle) }.take(RESULT_COUNT).map { recipient(it) }
        val inRecent = recent.map { it.key }.toSet()
        return others.map { recipient(it) }.filter { it.key !in inRecent }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    /** Searching: the channels that match (none for an `@` search). Otherwise every channel not in Recent, by name. */
    fun channels(channels: List<ChatChannel>, query: String, recent: List<MessageRecipient>): List<MessageRecipient> {
        val needle = term(query)
        if (needle.isNotEmpty()) {
            if (query.trim().startsWith("@")) return emptyList()
            return channels.filter { it.name.lowercase().contains(needle) }.take(RESULT_COUNT).map { recipient(it) }
        }
        val inRecent = recent.map { it.key }.toSet()
        return channels.map { recipient(it) }.filter { it.key !in inRecent }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    /** Tapping a recipient again takes it out. */
    fun toggled(list: List<MessageRecipient>, recipient: MessageRecipient): List<MessageRecipient> =
        if (list.any { it.key == recipient.key }) list.filter { it.key != recipient.key } else list + recipient

    /** Where the message goes: each channel and conversation, and one DM for all the people picked. */
    fun split(recipients: List<MessageRecipient>): DeliveryPlan {
        val conversations = mutableListOf<Destination>()
        val people = mutableListOf<String>()
        for (recipient in recipients) {
            when (recipient) {
                is MessageRecipient.Channel -> conversations.add(Destination(recipient.id, false, recipient.key))
                is MessageRecipient.Dm -> conversations.add(Destination(recipient.id, true, recipient.key))
                is MessageRecipient.Person -> people.add(recipient.userId)
            }
        }
        return DeliveryPlan(conversations, people)
    }

    fun canSend(recipients: List<MessageRecipient>, text: String, fileCount: Int, sending: Boolean): Boolean =
        recipients.isNotEmpty() && (text.isNotBlank() || fileCount > 0) && !sending
}
