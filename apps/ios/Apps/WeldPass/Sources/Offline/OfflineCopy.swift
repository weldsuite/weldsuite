import Foundation
import WeldPassAPI

/// The offline copy of the vaults (ADR PASS-010), as it lives in memory once
/// opened. The same JSON as the Expo app's `lib/offline/copy.ts` and the
/// Android app's, so the AutoFill extension reads any of them.
///
/// One copy per workspace, bound to the server, the person and the device it
/// was synced for: a copy that names anything else is never read.
struct OfflineCopy: Codable, Equatable {
    static let currentVersion = 1

    var version = OfflineCopy.currentVersion
    /// The server's origin (`https://app.weldsuite.eu`).
    let server: String
    let userId: String
    let workspaceId: String
    let deviceId: String
    /// The server's clock at the last sync; empty before the first.
    var syncedAt = ""
    var vaults: [String: CopiedVault] = [:]

    var owner: CopyOwner { CopyOwner(server: server, userId: userId, workspaceId: workspaceId, deviceId: deviceId) }
}

struct CopiedVault: Codable, Equatable {
    let vault: Components.Schemas.Vault
    let cursor: String
    let items: [String: Components.Schemas.SyncedItem]
}

/// Who and where a copy belongs to.
struct CopyOwner: Equatable {
    let server: String
    let userId: String
    let workspaceId: String
    let deviceId: String
}

enum SyncOutcome: Equatable {
    case wiped(reason: Components.Schemas.SyncResult.ReasonPayload?)
    case updated(OfflineCopy, removedVaultIDs: Set<String>)
}

/// The rules for applying a sync. Pure, so the merge is tested directly.
enum CopyRules {
    static func empty(_ owner: CopyOwner) -> OfflineCopy {
        OfflineCopy(server: owner.server, userId: owner.userId, workspaceId: owner.workspaceId, deviceId: owner.deviceId)
    }

    /// Whether a copy read from storage belongs to `owner`.
    static func belongs(_ copy: OfflineCopy, to owner: CopyOwner) -> Bool {
        copy.version == OfflineCopy.currentVersion && copy.owner == owner
    }

    /// The cursors to send: one per vault the copy holds.
    static func cursors(_ copy: OfflineCopy?) -> [String: String] {
        (copy?.vaults ?? [:]).mapValues(\.cursor)
    }

    /// Apply a sync. The server lists every vault the person can read now, so
    /// a vault the copy holds but the answer leaves out is dropped as well as
    /// the ones named in `removedVaultIds`.
    static func apply(_ result: Components.Schemas.SyncResult, to copy: OfflineCopy) -> SyncOutcome {
        if result.wipe { return .wiped(reason: result.reason) }
        let readable = Set(result.vaults.map(\.vault.id))
        var removed = Set(result.removedVaultIds)
        for id in copy.vaults.keys where !readable.contains(id) { removed.insert(id) }
        var next = copy
        next.syncedAt = result.syncedAt
        next.vaults = Dictionary(uniqueKeysWithValues: result.vaults.map { entry in
            (entry.vault.id, merge(copy.vaults[entry.vault.id], entry))
        })
        return .updated(next, removedVaultIDs: removed)
    }

    /// One vault of a sync over what the copy held of it: replaced when `full`, else merged.
    private static func merge(_ previous: CopiedVault?, _ entry: Components.Schemas.SyncedVault) -> CopiedVault {
        var items = entry.full ? [:] : (previous?.items ?? [:])
        for id in entry.deletedIds { items[id] = nil }
        for item in entry.items { items[item.value1.id] = item }
        return CopiedVault(vault: entry.vault, cursor: entry.cursor, items: items)
    }

    /// The vaults, as the vault list shows them, with their item counts from the copy.
    static func vaults(_ copy: OfflineCopy) -> [PassVault] {
        copy.vaults.values.map { copied in
            let vault = PassStore.vault(copied.vault)
            return PassVault(
                id: vault.id, kind: vault.kind, name: vault.name, role: vault.role,
                itemCount: copied.items.count, memberCount: vault.memberCount
            )
        }
    }

    /// Every item, as the item list shows them: the metadata, never the fields.
    static func items(_ copy: OfflineCopy) -> [PassItem] {
        copy.vaults.values.flatMap { $0.items.values.map { PassStore.item($0.value1) } }
    }

    static func fields(_ copy: OfflineCopy, vaultID: String, itemID: String) -> PassFields? {
        copy.vaults[vaultID]?.items[itemID].map { PassStore.fields($0.value2.fields) }
    }
}
