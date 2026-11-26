import CryptoKit
import Foundation
import Observation
import UIKit
import WeldCore
import WeldPassAPI

/// Where the offline copy stands.
enum OfflineStatus: Equatable {
    /// Signed out, or the server doesn't offer offline copies.
    case off
    /// This phone has no passcode to keep the key behind.
    case unavailable
    /// Waiting for the person to unlock.
    case locked
    /// The copy is open (it may still be empty until the first sync).
    case ready
    /// The workspace switched offline copies off.
    case disabled
    /// This phone's copy was revoked; it stays off until turned on again.
    case revoked
}

/// The offline copy in the running app (ADR PASS-010).
///
/// - **Opening**: after the app lock lets the person in, the copy's key is
///   read with that same authentication, so one Face ID opens both. The key
///   stays in memory while the app is unlocked and is dropped when it locks.
/// - **Syncing**: after every unlock, when the app comes back to the
///   foreground (at most every 30 s) and after every write.
/// - **Reading**: lists and item fields come from the copy while it's open,
///   so the app works without a connection. Edits go to the server.
/// - **Wiping**: on sign-out (this phone is revoked on the server first), when
///   the server says the phone was revoked or offline copies are off, and per
///   vault when the person loses access.
@MainActor
@Observable
final class OfflineStore {
    private(set) var status: OfflineStatus = .off
    private(set) var copy: OfflineCopy?
    private(set) var syncing = false
    /// The last sync couldn't reach the server: the lists are the copy from `copy.syncedAt`.
    private(set) var isOffline = false
    /// This phone's device id on the server, once registered.
    private(set) var deviceID: String?

    /// The copy to read from: open and synced at least once.
    var readable: OfflineCopy? {
        guard status == .ready, let copy, !copy.syncedAt.isEmpty else { return nil }
        return copy
    }

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let files = CopyFiles()
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let events = EventQueue(defaults: .standard)
    @ObservationIgnored private var key: SymmetricKey?
    @ObservationIgnored private var session: Session?
    @ObservationIgnored private var lastSyncAt = Date.distantPast

    private struct Session: Equatable {
        let server: String
        let userID: String
        let workspaceID: String
        var key: String { "\(server)|\(userID)|\(workspaceID)" }
    }

    init(env: AppEnvironment) {
        self.env = env
    }

    private var client: Client? {
        env.api.map { Client(serverURL: $0.serverURL, transport: $0.transport, middlewares: $0.middlewares) }
    }

    // MARK: - Following the session and the lock

    /// The app is unlocked in `workspace`: open its copy and sync.
    func open(person: Person, workspace: WorkspaceRef) async {
        let next = Session(server: env.serverURL.absoluteString, userID: person.id, workspaceID: workspace.id)
        if env.unavailableFeatures.contains("weldpass-offline") { return close(.off, session: next) }
        if !env.lock.hasScreenLock { return close(.unavailable, session: next) }
        if next == session, status == .ready, key != nil { return await syncIfDue() }
        session = next
        do {
            key = try CopyKey.open(context: env.lock.unlockedContext)
        } catch CopyKey.Problem.noPasscode {
            return close(.unavailable, session: next)
        } catch {
            return close(.locked, session: next)
        }
        if defaults.string(forKey: revokedKey(next)) != nil { return close(.revoked, session: next, keepKey: true) }
        let device = defaults.string(forKey: deviceKey(next))
        deviceID = device
        copy = device.map { load(CopyOwner(server: next.server, userId: next.userID, workspaceId: next.workspaceID, deviceId: $0)) }
        status = .ready
        isOffline = false
        await sync()
    }

    /// The app locked or signed out: drop the copy and its key from memory.
    func close(_ status: OfflineStatus = .locked) {
        close(status, session: session)
    }

    private func close(_ status: OfflineStatus, session: Session?, keepKey: Bool = false) {
        if !keepKey { key = nil }
        self.session = session
        self.status = status
        copy = nil
        syncing = false
        isOffline = false
    }

    /// Back in the foreground: sync when the last one was a while ago.
    func syncIfDue() async {
        if Date().timeIntervalSince(lastSyncAt) >= 30 { await sync() }
    }

    // MARK: - Syncing

    /// One sync, when the copy is open. Offline, the copy stays as it was and `isOffline` is set.
    func sync() async {
        guard let session, let key, status == .ready, !syncing, let client else { return }
        syncing = true
        defer {
            syncing = false
            lastSyncAt = Date()
        }
        do {
            try await runSync(session, key: key, client: client)
        } catch {
            isOffline = APIError.from(error).isNetwork
        }
    }

    private func runSync(_ session: Session, key: SymmetricKey, client: Client) async throws {
        guard var device = try await ensureDevice(session, client: client) else { return close(.off, session: session) }
        var owner = CopyOwner(server: session.server, userId: session.userID, workspaceId: session.workspaceID, deviceId: device)
        var current = copy.flatMap { CopyRules.belongs($0, to: owner) ? $0 : nil } ?? load(owner)
        var result = try await syncRequest(client, device: device, cursors: CopyRules.cursors(current))
        if result == nil {
            // The server no longer knows this device: register again and start from scratch, once.
            defaults.removeObject(forKey: deviceKey(session))
            files.delete(session.workspaceID)
            guard let again = try await ensureDevice(session, client: client) else { return close(.off, session: session) }
            device = again
            owner = CopyOwner(server: session.server, userId: session.userID, workspaceId: session.workspaceID, deviceId: device)
            current = CopyRules.empty(owner)
            result = try await syncRequest(client, device: device, cursors: [:])
        }
        guard let result else { return }
        switch CopyRules.apply(result, to: current) {
        case let .wiped(reason):
            // Switched off by the workspace: keep the registration, so the copy comes
            // back when it's switched on. Revoked: forget it, and don't register again
            // on our own (the person turns it on in Settings).
            let disabled = reason == .disabled
            wipeWorkspace(session, forgetDevice: !disabled)
            if reason == .revoked { defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: revokedKey(session)) }
            close(disabled ? .disabled : .revoked, session: session, keepKey: true)
        case let .updated(next, _):
            try files.write(session.workspaceID, CopyEnvelope.seal(JSONEncoder().encode(next), owner: owner, key: key))
            copy = next
            deviceID = device
            isOffline = false
            // Kept for the next sync when it fails.
            try? await events.flush(session.workspaceID) { batch in try await self.upload(batch, device: device, client: client) }
        }
    }

    /// The sync answer, or nil when the server doesn't know the device (404).
    private func syncRequest(_ client: Client, device: String, cursors: [String: String]) async throws -> Components.Schemas.SyncResult? {
        let body = Components.Schemas.SyncRequest(cursors: .init(additionalProperties: cursors))
        switch try await client.syncDevice(path: .init(deviceId: device), body: .json(body)) {
        case let .ok(ok):
            return try ok.body.json.data
        case let .default(status, response):
            if status == 404 { return nil }
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    private func upload(_ batch: [EventQueue.Event], device: String, client: Client) async throws {
        let events = batch.compactMap { event -> Components.Schemas.DeviceEvent? in
            guard let action = Components.Schemas.DeviceEvent.ActionPayload(rawValue: event.action.rawValue) else { return nil }
            return .init(vaultId: event.vaultId, itemId: event.itemId, action: action, at: event.at)
        }
        switch try await client.uploadDeviceEvents(path: .init(deviceId: device), body: .json(.init(events: events))) {
        case .ok: return
        case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    /// This phone's device id on the server, registering it the first time. Nil: the server keeps no copies.
    private func ensureDevice(_ session: Session, client: Client) async throws -> String? {
        if let known = defaults.string(forKey: deviceKey(session)) { return known }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let body = Components.Schemas.RegisterDevice(name: String(UIDevice.current.name.prefix(100)), platform: .ios, appVersion: version)
        switch try await client.registerDevice(body: .json(body)) {
        case let .created(created):
            let id = try created.body.json.data.id
            defaults.set(id, forKey: deviceKey(session))
            return id
        case let .default(status, response):
            if status == 404 || status == 405 { return nil }
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    /// The copy on the phone for `owner`. A missing file, or one that doesn't open or isn't theirs, is an empty copy.
    private func load(_ owner: CopyOwner) -> OfflineCopy {
        guard let key, let file = files.read(owner.workspaceId) else { return CopyRules.empty(owner) }
        if let json = try? CopyEnvelope.open(file, owner: owner, key: key),
           let copy = try? JSONDecoder().decode(OfflineCopy.self, from: json),
           CopyRules.belongs(copy, to: owner) {
            return copy
        }
        files.delete(owner.workspaceId)
        return CopyRules.empty(owner)
    }

    // MARK: - Events, devices, sign-out

    /// A reveal, copy or autofill done from the copy, for the vault's trail.
    func recordEvent(vaultID: String, itemID: String, action: EventQueue.Event.Action) {
        guard let session else { return }
        events.add(session.workspaceID, .init(vaultId: vaultID, itemId: itemID, action: action, at: ISO8601DateFormatter().string(from: Date())))
    }

    /// Turn the copy on again after this phone was revoked.
    func enableAgain(person: Person, workspace: WorkspaceRef) async {
        guard let session else { return }
        defaults.removeObject(forKey: revokedKey(session))
        self.session = nil
        await open(person: person, workspace: workspace)
    }

    /// The person's phones with a copy.
    func devices() async throws -> [Components.Schemas.Device] {
        guard let client else { return [] }
        switch try await client.listDevices() {
        case let .ok(ok): return try ok.body.json.data.filter { $0.revokedAt == nil }
        case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    /// Remove a phone's copy: it's wiped at that phone's next sync.
    func revoke(deviceID: String) async throws {
        guard let client else { return }
        switch try await client.revokeDevice(path: .init(deviceId: deviceID)) {
        case .noContent: return
        case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    /// Before signing out: revoke this phone on the server (best effort), then wipe every copy and the key.
    func signOut() async {
        if let session, let device = defaults.string(forKey: deviceKey(session)) {
            try? await revoke(deviceID: device)
        }
        files.deleteAll()
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix("weldpass:device:") || key.hasPrefix("weldpass:offline-") {
            defaults.removeObject(forKey: key)
        }
        CopyKey.delete()
        close(.off, session: nil)
    }

    private func wipeWorkspace(_ session: Session, forgetDevice: Bool) {
        files.delete(session.workspaceID)
        if forgetDevice { defaults.removeObject(forKey: deviceKey(session)) }
        events.clear(session.workspaceID)
    }

    private func deviceKey(_ session: Session) -> String { "weldpass:device:\(session.key)" }
    private func revokedKey(_ session: Session) -> String { "weldpass:offline-revoked:\(session.key)" }
}
