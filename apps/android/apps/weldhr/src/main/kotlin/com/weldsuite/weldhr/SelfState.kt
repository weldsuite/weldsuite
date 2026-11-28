package com.weldsuite.weldhr

import org.weldsuite.core.LoadState
import org.weldsuite.core.api.ApiException

/**
 * My HR needs two things: the `employees:self` permission and an employee
 * record linked to the signed-in member. Without either there is nothing to
 * show, so the screens say why instead of showing empty lists.
 */
sealed interface SelfState {
    data object Loading : SelfState
    data object NoAccess : SelfState
    data object NotLinked : SelfState
    data class Failed(val error: Throwable?) : SelfState
    data class Ready(val profile: Profile, val features: Features) : SelfState

    companion object {
        fun of(me: LoadState<Me>, access: LoadState<HrAccess>): SelfState {
            val data = me.data
            if (data == null && me.error == null) return Loading
            if (data == null) {
                // A 403 is the server saying "no My HR for you"; the permissions agree unless a role just changed.
                val forbidden = (me.error as? ApiException)?.status == 403
                val noSelf = access.data?.self == false
                return if (forbidden || noSelf) NoAccess else Failed(me.error)
            }
            val employee = data.employee ?: return NotLinked
            return Ready(employee, data.features)
        }
    }
}

/** The tabs a member sees: their own views, plus the team's where they have the permission. */
data class HrTabs(val schedule: Boolean, val absence: Boolean, val expenses: Boolean, val announcements: Boolean) {
    companion object {
        /** While permissions load the My HR tabs stay up, so they don't flicker away and back. */
        fun of(access: HrAccess, loading: Boolean): HrTabs {
            val self = access.self || loading
            return HrTabs(
                schedule = self || access.attendance,
                absence = self || access.leave || access.sickToday || access.approveLeave,
                expenses = self || access.approveExpenses,
                announcements = self,
            )
        }
    }
}

/** What the "+" offers on a tab: the main action and the ones above it. */
enum class AddAction { REQUEST_LEAVE, REQUEST_SHIFT, REPORT_SICK, NEW_EXPENSE, PHOTO_RECEIPT, UPLOAD_RECEIPT, NEW_ANNOUNCEMENT }

data class AddMenu(val main: AddAction, val entries: List<AddAction>, val direct: Boolean = false)

object AddMenus {
    /**
     * Each tab keeps to what it is about (the Expo app's AddButton): Expenses
     * the receipt, Absence time off and reporting sick, Schedule a shift
     * request straight away, Announcements a new one for who may post them.
     * Null on Home.
     */
    fun forTab(tab: String, features: Features, access: HrAccess): AddMenu? {
        if (tab == "home") return null
        if (tab == "schedule") return AddMenu(AddAction.REQUEST_SHIFT, emptyList(), direct = true)
        if (tab == "announcements" && access.createAnnouncements) return AddMenu(AddAction.NEW_ANNOUNCEMENT, emptyList(), direct = true)
        if (tab == "expenses" && features.declarations) return AddMenu(AddAction.PHOTO_RECEIPT, listOf(AddAction.UPLOAD_RECEIPT))
        val onAbsence = tab == "absence"
        val leave = if (features.leaveRequests) AddAction.REQUEST_LEAVE else null
        val main = leave ?: if (onAbsence) AddAction.REPORT_SICK else AddAction.REQUEST_SHIFT
        val entries = buildList {
            if (leave != null && !onAbsence) add(AddAction.REQUEST_SHIFT)
            if (main != AddAction.REPORT_SICK) add(AddAction.REPORT_SICK)
            if (features.declarations && !onAbsence) add(AddAction.NEW_EXPENSE)
        }
        return AddMenu(main, entries)
    }
}
