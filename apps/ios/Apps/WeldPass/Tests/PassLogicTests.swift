import XCTest
@testable import WeldPass

final class PassLogicTests: XCTestCase {
    private func vault(_ id: String, _ kind: PassVault.Kind, _ name: String, role: PassVault.Role? = .manager) -> PassVault {
        PassVault(id: id, kind: kind, name: name, role: role, itemCount: nil, memberCount: nil)
    }

    private func item(_ id: String, _ title: String, kind: PassItem.Kind = .login, subtitle: String? = nil, host: String? = nil, vaultID: String = "v1") -> PassItem {
        PassItem(
            id: id, vaultID: vaultID, kind: kind, title: title, subtitle: subtitle,
            url: host.map { "https://\($0)" }, host: host, hasTotp: false, updatedAt: "2026-01-01T00:00:00Z"
        )
    }

    func testPersonalVaultFirstThenSharedByName() {
        let sorted = PassLogic.sortVaults([vault("b", .shared, "beta"), vault("p", .personal, "Personal"), vault("a", .shared, "Alpha")])
        XCTAssertEqual(sorted.map(\.id), ["p", "a", "b"])
    }

    func testEveryWordMustMatch() {
        let items = [
            item("1", "GitHub", subtitle: "gert", host: "github.com"),
            item("2", "GitLab", subtitle: "ops", host: "gitlab.com"),
            item("3", "Visa", kind: .card, subtitle: "•••• 4242"),
        ]
        XCTAssertEqual(PassLogic.filterItems(items, query: "git gert").map(\.id), ["1"])
        XCTAssertEqual(PassLogic.filterItems(items, query: "  GIT ").map(\.id), ["1", "2"])
        XCTAssertEqual(PassLogic.filterItems(items, query: "", kind: .card).map(\.id), ["3"])
        XCTAssertEqual(PassLogic.filterItems(items, query: "", vaultID: "other").map(\.id), [])
    }

    func testVaultRoles() {
        XCTAssertTrue(PassLogic.canEdit(vault("v", .shared, "x", role: .editor)))
        XCTAssertTrue(PassLogic.canEdit(vault("v", .shared, "x", role: .manager)))
        XCTAssertFalse(PassLogic.canEdit(vault("v", .shared, "x", role: .viewer)))
        XCTAssertTrue(PassLogic.isNonMemberView(vault("v", .shared, "x", role: nil)))
        XCTAssertFalse(PassLogic.isNonMemberView(nil))
    }

    func testTotpCodesSplitInTheMiddle() {
        XCTAssertEqual(PassLogic.formatTotpCode("123456"), "123 456")
        XCTAssertEqual(PassLogic.formatTotpCode("1234567"), "1234 567")
        XCTAssertEqual(PassLogic.formatTotpCode("123"), "123")
    }

    func testSecondsUntilRoundsUp() {
        let now = PassLogic.parseDate("2026-11-26T10:00:00Z")!
        XCTAssertEqual(PassLogic.secondsUntil("2026-11-26T10:00:30Z", now: now), 30)
        XCTAssertEqual(PassLogic.secondsUntil("2026-11-26T10:00:00.200Z", now: now), 1)
        XCTAssertEqual(PassLogic.secondsUntil("2026-11-26T09:59:00Z", now: now), 0)
        XCTAssertEqual(PassLogic.secondsUntil("soon", now: now), 0)
    }

    func testOnlyHttpLinksOpen() {
        XCTAssertEqual(PassLogic.safeHref("example.com/login")?.absoluteString, "https://example.com/login")
        XCTAssertNil(PassLogic.safeHref("javascript:alert(1)"))
        XCTAssertNil(PassLogic.safeHref("ftp://example.com"))
        XCTAssertNil(PassLogic.safeHref(""))
        XCTAssertNil(PassLogic.safeHref(nil))
    }
}
