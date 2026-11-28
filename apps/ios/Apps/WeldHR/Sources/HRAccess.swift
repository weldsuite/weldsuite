import Foundation
import WeldCore

/// Who sees which half of the app, the same as the Expo app's lib/access.ts:
/// My HR needs `employees:self`; each team view needs the permission behind
/// its endpoint. UX only: the server checks every request again.
struct HRAccess: Equatable {
    /// My HR: the member's own record, time off, expenses, payslips.
    var me = false
    /// Approve or decline leave requests.
    var approveLeave = false
    /// Approve or decline expense claims.
    var approveExpenses = false
    /// Everyone's shifts and hours (Schedule → Team).
    var attendance = false
    /// Everyone's approved leave (Absence → Absences).
    var leave = false
    /// Everyone's sick reports.
    var sickToday = false
    /// The employee directory.
    var directory = false
    /// Post announcements (the "+" on Announcements).
    var createAnnouncements = false

    static let noAccess = HRAccess()

    /// WeldHR's objects are granted per app; these are all WeldHR's own (`@weldsuite/permissions` apps.ts).
    static let app = "weldhr"

    /// The access of a member with `permissions` and `denies` (`GET /api/me/permissions`). Every key
    /// checked here belongs to WeldHR alone, so with the app enforced or not the check is the same:
    /// the key qualified with `weldhr:`, or the legacy unqualified grant; a deny of either wins.
    static func resolve(permissions: [String], denies: [String]) -> HRAccess {
        func can(_ key: String) -> Bool {
            let qualified = "\(app):\(key)"
            if denies.contains(where: { matches($0, qualified) || matches($0, key) }) { return false }
            return permissions.contains { matches($0, qualified) || matches($0, key) }
        }
        return HRAccess(
            me: can("employees:self"),
            approveLeave: can("leave:read") && can("leave:approve"),
            approveExpenses: can("declarations:read") && can("declarations:approve"),
            attendance: can("attendance:read"),
            leave: can("leave:read"),
            sickToday: can("absences:read"),
            directory: can("employees:read"),
            createAnnouncements: can("announcements:create")
        )
    }

    /// Whether a grant matches a concrete key: `*` everything, a trailing `*` the rest,
    /// a middle `*` any one segment (`@weldsuite/permissions` engine.ts).
    static func matches(_ grant: String, _ required: String) -> Bool {
        if grant == "*" || grant == required { return true }
        let have = grant.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let want = required.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        for (index, part) in have.enumerated() {
            if part == "*", index == have.count - 1 { return true }
            if index >= want.count { return false }
            if part == "*" { continue }
            if part != want[index] { return false }
        }
        return have.count == want.count
    }
}

/// My HR needs `employees:self` and an employee record linked to the member;
/// without either the screens say why instead of showing empty lists.
enum SelfState: Equatable {
    case loading
    case noAccess
    case notLinked
    case failed(APIError?)
    case ready(HRProfile, HRFeatures)

    static func of(me: LoadState<HRMe>, access: LoadState<HRAccess>) -> SelfState {
        guard let data = me.data else {
            guard let error = me.error else { return .loading }
            // A 403 is the server saying "no My HR for you"; the permissions agree unless a role just changed.
            if error.status == 403 || access.data?.me == false { return .noAccess }
            return .failed(error)
        }
        guard let employee = data.employee else { return .notLinked }
        return .ready(employee, data.features)
    }

    var profile: HRProfile? {
        if case let .ready(profile, _) = self { return profile }
        return nil
    }

    var features: HRFeatures? {
        if case let .ready(_, features) = self { return features }
        return nil
    }
}

/// The tabs a member sees: their own views, plus the team's where they have the permission.
struct HRTabs: Equatable {
    let schedule: Bool
    let absence: Bool
    let expenses: Bool
    let announcements: Bool

    /// While permissions load the My HR tabs stay up, so they don't flicker away and back.
    static func of(_ access: HRAccess, loading: Bool) -> HRTabs {
        let me = access.me || loading
        return HRTabs(
            schedule: me || access.attendance,
            absence: me || access.leave || access.sickToday || access.approveLeave,
            expenses: me || access.approveExpenses,
            announcements: me
        )
    }
}

/// What the "+" offers on a tab: the main action and the ones above it.
enum AddAction: Equatable {
    case requestLeave, requestShift, reportSick, newExpense, photoReceipt, uploadReceipt, newAnnouncement
}

struct AddMenu: Equatable {
    let main: AddAction
    let entries: [AddAction]
    var direct = false
}

enum HRTab: String, Hashable, CaseIterable {
    case home, schedule, absence, expenses, announcements
}

enum AddMenus {
    /// Each tab keeps to what it is about (the Expo app's AddButton). Nil on Home.
    static func forTab(_ tab: HRTab, features: HRFeatures, access: HRAccess) -> AddMenu? {
        switch tab {
        case .home: return nil
        case .schedule: return AddMenu(main: .requestShift, entries: [], direct: true)
        case .announcements where access.createAnnouncements: return AddMenu(main: .newAnnouncement, entries: [], direct: true)
        case .expenses where features.declarations: return AddMenu(main: .photoReceipt, entries: [.uploadReceipt])
        default: break
        }
        let onAbsence = tab == .absence
        let leave: AddAction? = features.leaveRequests ? .requestLeave : nil
        let main = leave ?? (onAbsence ? .reportSick : .requestShift)
        var entries: [AddAction] = []
        if leave != nil, !onAbsence { entries.append(.requestShift) }
        if main != .reportSick { entries.append(.reportSick) }
        if features.declarations, !onAbsence { entries.append(.newExpense) }
        return AddMenu(main: main, entries: entries)
    }
}
