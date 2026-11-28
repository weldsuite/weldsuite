import CryptoKit
import WeldPassAPI
import XCTest
@testable import WeldPass

final class OfflineCopyTests: XCTestCase {
    private let owner = CopyOwner(server: "https://app.weldsuite.eu", userId: "user_1", workspaceId: "ws_1", deviceId: "dev_1")

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func vaultJSON(_ id: String) -> String {
        #"{"id":"\#(id)","kind":"shared","ownerId":null,"name":"\#(id)","description":null,"createdBy":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","role":"editor"}"#
    }

    private func itemJSON(_ id: String, _ vaultID: String, password: String = "pw") -> String {
        #"{"id":"\#(id)","vaultId":"\#(vaultID)","type":"login","title":"\#(id)","subtitle":"me","url":null,"host":null,"hasTotp":false,"passwordChangedAt":null,"version":1,"createdBy":null,"updatedBy":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","fields":{"username":"me","password":"\#(password)","totp":"","notes":""}}"#
    }

    private func result(_ vaults: [(id: String, full: Bool, items: [String], deleted: [String])], removed: [String] = []) throws -> Components.Schemas.SyncResult {
        let entries = vaults.map { vault in
            #"{"vault":\#(vaultJSON(vault.id)),"cursor":"c-\#(vault.id)-\#(vault.items.count)","full":\#(vault.full),"items":[\#(vault.items.joined(separator: ","))],"deletedIds":[\#(vault.deleted.map { "\"\($0)\"" }.joined(separator: ","))]}"#
        }
        let json = #"{"wipe":false,"reason":null,"syncedAt":"2026-11-26T10:00:00Z","vaults":[\#(entries.joined(separator: ","))],"removedVaultIds":[\#(removed.map { "\"\($0)\"" }.joined(separator: ","))]}"#
        return try decode(Components.Schemas.SyncResult.self, json)
    }

    private func updated(_ outcome: SyncOutcome) -> OfflineCopy {
        guard case let .updated(copy, _) = outcome else { XCTFail("not updated"); return CopyRules.empty(owner) }
        return copy
    }

    func testFirstSyncFillsTheCopy() throws {
        let copy = updated(CopyRules.apply(try result([("v1", true, [itemJSON("a", "v1")], [])]), to: CopyRules.empty(owner)))
        XCTAssertEqual(Set(copy.vaults["v1"]!.items.keys), ["a"])
        XCTAssertEqual(CopyRules.cursors(copy), ["v1": "c-v1-1"])
        XCTAssertEqual(copy.syncedAt, "2026-11-26T10:00:00Z")
    }

    func testMergesChangesAndDeletionsAndReplacesWhenFull() throws {
        let first = updated(CopyRules.apply(try result([("v1", true, [itemJSON("a", "v1"), itemJSON("b", "v1")], [])]), to: CopyRules.empty(owner)))
        let merged = updated(CopyRules.apply(try result([("v1", false, [itemJSON("a", "v1", password: "new"), itemJSON("c", "v1")], ["b"])]), to: first))
        XCTAssertEqual(Set(merged.vaults["v1"]!.items.keys), ["a", "c"])
        XCTAssertEqual(CopyRules.fields(merged, vaultID: "v1", itemID: "a")?.password, "new")
        let replaced = updated(CopyRules.apply(try result([("v1", true, [itemJSON("z", "v1")], [])]), to: merged))
        XCTAssertEqual(Set(replaced.vaults["v1"]!.items.keys), ["z"])
    }

    func testDropsVaultsThePersonCanNoLongerRead() throws {
        let first = updated(CopyRules.apply(try result([("v1", true, [itemJSON("a", "v1")], []), ("v2", true, [], [])]), to: CopyRules.empty(owner)))
        guard case let .updated(copy, removed) = CopyRules.apply(try result([("v2", false, [], [])], removed: ["v9"]), to: first) else {
            return XCTFail("not updated")
        }
        XCTAssertEqual(Set(copy.vaults.keys), ["v2"])
        XCTAssertEqual(removed, ["v1", "v9"])
    }

    func testTheServerCanTellThePhoneToWipe() throws {
        let wipe = try decode(Components.Schemas.SyncResult.self, #"{"wipe":true,"reason":"revoked","syncedAt":"","vaults":[],"removedVaultIds":[]}"#)
        XCTAssertEqual(CopyRules.apply(wipe, to: CopyRules.empty(owner)), .wiped(reason: .revoked))
    }

    func testACopyGoesWhenItsWorkspaceLeavesTheList() {
        XCTAssertEqual(CopyRules.copiesToDrop(onPhone: ["ws_1", "ws_gone"], workspaces: ["ws_1", "ws_2"]), ["ws_gone"])
        XCTAssertEqual(CopyRules.copiesToDrop(onPhone: ["ws_1"], workspaces: ["ws_1"]), [])
        // Removed from every workspace: every copy goes.
        XCTAssertEqual(CopyRules.copiesToDrop(onPhone: ["ws_2", "ws_1"], workspaces: []), ["ws_1", "ws_2"])
    }

    func testASyncRefusedWith403MeansTheAccessIsGone() {
        // Removed from the workspace, or WeldPass taken away: the server can't
        // answer "wipe" to someone it no longer lets in.
        XCTAssertTrue(CopyRules.lostAccess(status: 403))
        // An expired token, a missing device, an outage, no answer: the copy stays.
        for status in [401, 404, 500, 503, 0] {
            XCTAssertFalse(CopyRules.lostAccess(status: status), "\(status)")
        }
        XCTAssertFalse(CopyRules.lostAccess(status: nil))
    }

    func testListsCarryNoFieldsAndCountItems() throws {
        let copy = updated(CopyRules.apply(try result([("v1", true, [itemJSON("a", "v1"), itemJSON("b", "v1")], [])]), to: CopyRules.empty(owner)))
        XCTAssertEqual(CopyRules.vaults(copy).first?.itemCount, 2)
        XCTAssertEqual(CopyRules.items(copy).map(\.id).sorted(), ["a", "b"])
        XCTAssertNil(CopyRules.fields(copy, vaultID: "v2", itemID: "a"))
    }

    func testCopyBelongsOnlyToItsOwner() {
        let copy = CopyRules.empty(owner)
        XCTAssertTrue(CopyRules.belongs(copy, to: owner))
        XCTAssertFalse(CopyRules.belongs(copy, to: CopyOwner(server: owner.server, userId: owner.userId, workspaceId: owner.workspaceId, deviceId: "dev_2")))
    }

    func testSealedFileOpensWithItsKeyAndOwnerOnly() throws {
        let key = SymmetricKey(size: .bits256)
        let json = Data(#"{"version":1}"#.utf8)
        let file = try CopyEnvelope.seal(json, owner: owner, key: key)
        XCTAssertEqual(file.prefix(4), Data("WPO1".utf8))
        XCTAssertEqual(try CopyEnvelope.open(file, owner: owner, key: key), json)
        let other = CopyOwner(server: owner.server, userId: owner.userId, workspaceId: "ws_2", deviceId: owner.deviceId)
        XCTAssertThrowsError(try CopyEnvelope.open(file, owner: other, key: key))
        XCTAssertThrowsError(try CopyEnvelope.open(file, owner: owner, key: SymmetricKey(size: .bits256)))
        XCTAssertNil(try CopyEnvelope.open(Data([1, 2, 3]), owner: owner, key: key))
    }

    func testCopyJSONRoundTrips() throws {
        let copy = updated(CopyRules.apply(try result([("v1", true, [itemJSON("a", "v1")], [])]), to: CopyRules.empty(owner)))
        let decoded = try JSONDecoder().decode(OfflineCopy.self, from: JSONEncoder().encode(copy))
        XCTAssertEqual(decoded, copy)
    }

    func testEventsUploadInBatchesAndKeepWhatFailed() async throws {
        let defaults = UserDefaults(suiteName: "weldpass-tests-\(UUID().uuidString)")!
        let queue = EventQueue(defaults: defaults)
        for index in 0..<1200 {
            queue.add("ws_1", .init(vaultId: "v1", itemId: "i\(index)", action: .copied, at: "2026-11-26T10:00:00Z"))
        }
        var batches: [Int] = []
        try await queue.flush("ws_1") { batches.append($0.count) }
        XCTAssertEqual(batches, [500, 500, 200])
        XCTAssertTrue(queue.read("ws_1").isEmpty)

        for index in 0..<3 {
            queue.add("ws_1", .init(vaultId: "v1", itemId: "i\(index)", action: .revealed, at: "2026-11-26T10:00:00Z"))
        }
        try? await queue.flush("ws_1") { _ in throw URLError(.notConnectedToInternet) }
        XCTAssertEqual(queue.read("ws_1").count, 3)
    }
}
