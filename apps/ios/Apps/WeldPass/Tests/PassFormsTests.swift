import XCTest
@testable import WeldPass

final class PassFormsTests: XCTestCase {
    func testLoginSendsOnlyItsOwnFields() {
        var values = ItemFormValues(kind: .login, vaultID: "v1")
        values.title = "  GitHub "
        values.url = " "
        values.username = "gert"
        values.totp = " JBSW "
        values.number = "4242"
        values.content = "stale"
        let input = PassForms.input(from: values)
        XCTAssertEqual(input.kind, .login)
        XCTAssertEqual(input.title, "GitHub")
        XCTAssertNil(input.url)
        XCTAssertEqual(input.fields.username, "gert")
        XCTAssertEqual(input.fields.totp, "JBSW")
        XCTAssertNil(input.fields.number)
        XCTAssertNil(input.fields.content)
        XCTAssertEqual(input.fields.apps, [])
    }

    func testCardSendsItsCardFieldsAndNotes() {
        var values = ItemFormValues(kind: .card, vaultID: "v1")
        values.title = "Visa"
        values.number = " 4242 "
        values.username = "stale"
        let input = PassForms.input(from: values)
        XCTAssertEqual(input.fields.number, "4242")
        XCTAssertEqual(input.fields.notes, "")
        XCTAssertNil(input.fields.username)
        XCTAssertNil(input.url)
    }

    func testAppListsAreSplitAndChecked() {
        let apps = PassForms.parseAppList("com.example.app\n com.example.app, org.test;not a package")
        XCTAssertEqual(apps, ["com.example.app", "org.test", "not", "a", "package"])
        XCTAssertEqual(PassForms.invalidApps(apps), ["not", "a", "package"])
    }

    func testStrengthFollowsThePlatformThresholds() {
        XCTAssertEqual(PassForms.strength("password"), .weak)
        XCTAssertEqual(PassForms.strength("abcdefgh"), .weak)
        XCTAssertEqual(PassForms.entropyBits(""), 0)
        XCTAssertEqual(PassForms.strength("k7#Pq9!mZ2@wX4^v"), .strong)
    }

    func testGeneratedPasswordsHaveTheLengthAndEveryClass() {
        for _ in 0..<50 {
            let password = PassForms.generatePassword(length: 12)
            XCTAssertEqual(password.count, 12)
            XCTAssertTrue(password.contains { $0.isLowercase })
            XCTAssertTrue(password.contains { $0.isUppercase })
            XCTAssertTrue(password.contains { $0.isNumber })
            XCTAssertTrue(password.contains { !$0.isLetter && !$0.isNumber })
            XCTAssertFalse(password.contains { "l1IO0".contains($0) })
        }
        let plain = PassForms.generatePassword(length: 3, uppercase: false, digits: false, symbols: false)
        XCTAssertEqual(plain.count, 8)
        XCTAssertTrue(plain.allSatisfy { $0.isLowercase })
    }

    func testDefaultVaultForANewItem() {
        let personal = PassVault(id: "p", kind: .personal, name: "Personal", role: .manager, itemCount: nil, memberCount: nil)
        let shared = PassVault(id: "s", kind: .shared, name: "Team", role: .editor, itemCount: nil, memberCount: nil)
        let viewer = PassVault(id: "v", kind: .shared, name: "Read", role: .viewer, itemCount: nil, memberCount: nil)
        XCTAssertEqual(PassLogic.defaultCreateVaultID([shared, personal], selected: "s"), "s")
        XCTAssertEqual(PassLogic.defaultCreateVaultID([shared, personal], selected: "v"), "p")
        XCTAssertEqual(PassLogic.defaultCreateVaultID([viewer], selected: nil), nil)
    }
}
