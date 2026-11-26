import CoreAPI
import XCTest
@testable import WeldCore

final class CoreLogicTests: XCTestCase {
    private let app = AppIdentity(
        code: "weldpass",
        name: "WeldPass",
        scheme: "weldpass",
        requiredModules: ["pass"],
        euServerURL: URL(string: "https://app.weldsuite.eu")!,
        version: "2.0.0",
        storeURL: URL(string: "https://apps.apple.com")!
    )

    private func config(_ json: String) throws -> Components.Schemas.RuntimeConfig {
        try JSONDecoder().decode(Components.Schemas.RuntimeConfig.self, from: Data(json.utf8))
    }

    private let weldID = """
    {"backend":"rust","modules":["core","pass"],"auth":{"provider":"oidc","issuer":"https://auth.weldsuite.eu",
    "mobileClientId":"weldsuite-mobile","scopes":["openid","profile","email","offline_access"],"workspaceSource":"header"},
    "somethingNew":{"a":1}}
    """

    func testWeldIDServerIsAccepted() throws {
        let result = assessServer(try config(weldID), app: app)
        guard case let .success(settings) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(settings.clientID, "weldsuite-mobile")
        XCTAssertEqual(settings.issuer.absoluteString, "https://auth.weldsuite.eu")
    }

    func testServerWithoutMobileClientIsRefused() throws {
        let json = weldID.replacingOccurrences(of: "\"mobileClientId\":\"weldsuite-mobile\",", with: "")
        XCTAssertEqual(assessServer(try config(json), app: app), .failure(.noMobileSignIn))
    }

    func testClaimModeIsNotSupportedYet() throws {
        let json = weldID.replacingOccurrences(of: "\"header\"", with: "\"claim\"")
        XCTAssertEqual(assessServer(try config(json), app: app), .failure(.noMobileSignIn))
    }

    func testServerWithoutPassModuleIsUnavailable() throws {
        let json = weldID.replacingOccurrences(of: "[\"core\",\"pass\"]", with: "[\"core\",\"crm\"]")
        XCTAssertEqual(assessServer(try config(json), app: app), .failure(.appUnavailable))
    }

    func testVersionGate() {
        XCTAssertTrue(isBelowMinimumVersion("2.0.0", minimum: "2.0.1"))
        XCTAssertTrue(isBelowMinimumVersion("2.9", minimum: "2.10"))
        XCTAssertFalse(isBelowMinimumVersion("2.10.0", minimum: "2.9.9"))
        XCTAssertFalse(isBelowMinimumVersion("2.0.0", minimum: "2.0"))
        XCTAssertFalse(isBelowMinimumVersion("2.0.0-beta.1", minimum: "2.0.0"))
        XCTAssertFalse(isBelowMinimumVersion("2.0.0", minimum: nil))
        XCTAssertFalse(isBelowMinimumVersion("2.0.0", minimum: "soon"))
    }

    func testWorkspaceChoice() {
        let one = [WorkspaceRef(id: "ws_1", name: "Acme")]
        let two = one + [WorkspaceRef(id: "ws_2", name: "Beta")]
        XCTAssertEqual(chooseActiveWorkspace(one, current: nil, chosenAfterReadStarted: false), "ws_1")
        XCTAssertEqual(chooseActiveWorkspace(two, current: "ws_2", chosenAfterReadStarted: false), "ws_2")
        XCTAssertNil(chooseActiveWorkspace(two, current: "ws_gone", chosenAfterReadStarted: false))
        XCTAssertEqual(chooseActiveWorkspace(two, current: "ws_new", chosenAfterReadStarted: true), "ws_new")
    }

    func testStorageID() {
        XCTAssertEqual(storageID(for: URL(string: "https://app.weldsuite.eu")!), "app.weldsuite.eu")
        XCTAssertEqual(storageID(for: URL(string: "https://example.com:8443")!), "example.com_8443")
    }

    func testPersonFromClaims() {
        // {"sub":"user_1","name":"Ada","email":"ada@example.com"}
        let token = "x.eyJzdWIiOiJ1c2VyXzEiLCJuYW1lIjoiQWRhIiwiZW1haWwiOiJhZGFAZXhhbXBsZS5jb20ifQ.y"
        XCTAssertEqual(person(fromClaims: jwtClaims(token)), Person(id: "user_1", name: "Ada", email: "ada@example.com"))
    }
}
