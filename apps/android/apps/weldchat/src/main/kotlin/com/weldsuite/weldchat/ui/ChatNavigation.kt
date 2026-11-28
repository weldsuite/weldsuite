package com.weldsuite.weldchat.ui

import android.net.Uri
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Home
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import com.weldsuite.weldchat.R

/** The tabs: Home, Direct messages, Activity and (where the server has calls) Calls. */
enum class ChatTab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    HOME("home", R.string.weldchat_tabs_home, Icons.Filled.Home, "tab-home"),
    DMS("dms", R.string.weldchat_tabs_direct_messages, Icons.AutoMirrored.Filled.Chat, "tab-dms"),
    ACTIVITY("activity", R.string.weldchat_tabs_activity, Icons.Filled.AlternateEmail, "tab-activity"),
    CALLS("calls", R.string.weldchat_tabs_calls, Icons.Filled.Call, "tab-calls"),
    ;

    companion object {
        fun of(route: String?): ChatTab? = entries.firstOrNull { it.route == route }
    }
}

/**
 * The routes of the screens pushed on the tabs (iOS `ChatRoute`) and of the
 * create screens (iOS `ChatSheet`, full screens here). Arguments go in as
 * path segments or query values, encoded.
 */
object ChatRoutes {
    const val CHANNEL = "channel/{channelId}?name={name}&type={type}&entityType={entityType}"
    const val THREAD = "thread/{messageId}?channelId={channelId}&draft={draft}"
    const val CHANNEL_INFO = "channel-info/{channelId}?name={name}"
    const val MEMBER = "member/{userId}"
    const val DRAFTS = "drafts"
    const val SAVED = "saved"
    const val RECORDS = "records?type={type}"
    const val SEARCH = "search"
    const val SETTINGS = "settings"
    const val PROFILE = "profile"
    const val NEW_CHANNEL = "new-channel?sectionId={sectionId}"
    const val NEW_CATEGORY = "new-category"
    const val NEW_DM = "new-dm?group={group}"
    const val NEW_MESSAGE = "new-message"
    const val INVITE_PEOPLE = "invite-people/{channelId}?name={name}"

    /** The create screens: no tab bar, and [ChatNavigator.finishSheet] leaves them. */
    val sheets = setOf(NEW_CHANNEL, NEW_CATEGORY, NEW_DM, NEW_MESSAGE, INVITE_PEOPLE)

    fun encode(value: String?): String = Uri.encode(value.orEmpty())
}

/**
 * Opens screens from anywhere, as the iOS `ChatNavigator` does: pushes on
 * the current tab, switches tabs, opens and leaves the create screens.
 * [tab] is the tab shown (Compose state); the app keeps it in step with the
 * back stack.
 */
class ChatNavigator(val nav: NavHostController) {
    var tab by mutableStateOf(ChatTab.HOME)

    fun selectTab(next: ChatTab) {
        tab = next
        nav.navigate(next.route) {
            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    fun openConversation(channelId: String, name: String? = null, type: String? = null, entityType: String? = null) {
        val query = buildList {
            name?.let { add("name=${ChatRoutes.encode(it)}") }
            type?.let { add("type=${ChatRoutes.encode(it)}") }
            entityType?.let { add("entityType=${ChatRoutes.encode(it)}") }
        }
        nav.navigate("channel/${ChatRoutes.encode(channelId)}" + if (query.isEmpty()) "" else query.joinToString("&", prefix = "?"))
    }

    fun openThread(messageId: String, channelId: String, draft: String? = null) {
        val draftPart = draft?.let { "&draft=${ChatRoutes.encode(it)}" }.orEmpty()
        nav.navigate("thread/${ChatRoutes.encode(messageId)}?channelId=${ChatRoutes.encode(channelId)}$draftPart")
    }

    fun openChannelInfo(channelId: String, name: String) = nav.navigate("channel-info/${ChatRoutes.encode(channelId)}?name=${ChatRoutes.encode(name)}")

    fun openMember(userId: String) = nav.navigate("member/${ChatRoutes.encode(userId)}")

    fun openDrafts() = nav.navigate(ChatRoutes.DRAFTS)

    fun openSaved() = nav.navigate(ChatRoutes.SAVED)

    fun openRecords(type: String? = null) = nav.navigate(if (type == null) "records" else "records?type=${ChatRoutes.encode(type)}")

    fun openSearch() = nav.navigate(ChatRoutes.SEARCH)

    fun openSettings() = nav.navigate(ChatRoutes.SETTINGS)

    fun openProfile() = nav.navigate(ChatRoutes.PROFILE)

    fun newChannel(sectionId: String? = null) =
        nav.navigate(if (sectionId == null) "new-channel" else "new-channel?sectionId=${ChatRoutes.encode(sectionId)}")

    fun newCategory() = nav.navigate(ChatRoutes.NEW_CATEGORY)

    fun newDm(group: Boolean = false) = nav.navigate("new-dm?group=$group")

    fun newMessage() = nav.navigate(ChatRoutes.NEW_MESSAGE)

    fun invitePeople(channelId: String, name: String) =
        nav.navigate("invite-people/${ChatRoutes.encode(channelId)}?name=${ChatRoutes.encode(name)}")

    fun back() {
        nav.popBackStack()
    }

    /** Back to the tab's root (after leaving or deleting a channel). */
    fun popToRoot() {
        if (!nav.popBackStack(tab.route, inclusive = false)) selectTab(tab)
    }

    /** Close a create screen, then open what it made ([then] gets this navigator). */
    fun finishSheet(then: (ChatNavigator.() -> Unit)? = null) {
        nav.popBackStack()
        then?.invoke(this)
    }
}
