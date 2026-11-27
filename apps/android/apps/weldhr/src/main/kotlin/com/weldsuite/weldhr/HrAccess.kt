package com.weldsuite.weldhr

/**
 * Who sees which half of the app, the same as the Expo app's lib/access.ts
 * and the platform's WeldHR access: My HR needs `employees:self`; each team
 * view needs the permission behind its endpoint. UX only: the server checks
 * every request again.
 */
data class HrAccess(
    /** My HR: the member's own record, time off, expenses, payslips. */
    val self: Boolean = false,
    /** Approve or decline leave requests. */
    val approveLeave: Boolean = false,
    /** Approve or decline expense claims. */
    val approveExpenses: Boolean = false,
    /** Everyone's shifts and hours (Schedule → Team). */
    val attendance: Boolean = false,
    /** Everyone's approved leave (Absence → Absences). */
    val leave: Boolean = false,
    /** Everyone's sick reports. */
    val sickToday: Boolean = false,
    /** The employee directory. */
    val directory: Boolean = false,
    /** Post announcements (the "+" on Announcements). */
    val createAnnouncements: Boolean = false,
) {
    val team: Boolean get() = approveLeave || approveExpenses || sickToday || directory || attendance || leave

    companion object {
        val NONE = HrAccess()

        /** WeldHR's objects are granted per app; these are all WeldHR's own (`@weldsuite/permissions` apps.ts). */
        const val APP = "weldhr"

        /**
         * The access of a member with [permissions] and [denies] (`GET /api/me/permissions`).
         * Every key checked here belongs to WeldHR alone, so with the app enforced or not the
         * check is the same: the key qualified with `weldhr:`, or the legacy unqualified grant;
         * a deny of either wins.
         */
        fun resolve(permissions: List<String>, denies: List<String>): HrAccess {
            fun can(key: String): Boolean {
                val qualified = "$APP:$key"
                if (denies.any { matches(it, qualified) || matches(it, key) }) return false
                return permissions.any { matches(it, qualified) || matches(it, key) }
            }
            return HrAccess(
                self = can("employees:self"),
                approveLeave = can("leave:read") && can("leave:approve"),
                approveExpenses = can("declarations:read") && can("declarations:approve"),
                attendance = can("attendance:read"),
                leave = can("leave:read"),
                sickToday = can("absences:read"),
                directory = can("employees:read"),
                createAnnouncements = can("announcements:create"),
            )
        }

        /**
         * Whether a grant matches a concrete key: `*` everything, a trailing
         * `*` the rest, a middle `*` any one segment (`@weldsuite/permissions` engine.ts).
         */
        fun matches(grant: String, required: String): Boolean {
            if (grant == "*" || grant == required) return true
            val have = grant.split(':')
            val want = required.split(':')
            for (index in have.indices) {
                val part = have[index]
                if (part == "*" && index == have.lastIndex) return true
                if (index >= want.size) return false
                if (part == "*") continue
                if (part != want[index]) return false
            }
            return have.size == want.size
        }
    }
}
