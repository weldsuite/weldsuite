import SwiftUI
import WeldCore
import WeldPassAPI

/// The offline copy in Settings: where it stands, "Sync now" or "Turn on
/// again", and the person's phones with a copy, which they can remove.
struct OfflineSection: View {
    let offline: OfflineStore
    let person: Person
    let workspace: WorkspaceRef

    @Environment(ToastCenter.self) private var toast
    @State private var devices: [Components.Schemas.Device] = []
    @State private var removing: Components.Schemas.Device?

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 2) {
                Text(PassStrings.settingsOffline)
                Text(statusLine).font(.inter(.subheadline)).foregroundStyle(.secondary)
            }
            switch offline.status {
            case .ready:
                Button(PassStrings.settingsSyncNow) { Task { await offline.sync() } }
                    .disabled(offline.syncing)
                    .accessibilityIdentifier("sync-now")
            case .revoked:
                Button(PassStrings.settingsTurnOnAgain) { Task { await offline.enableAgain(person: person, workspace: workspace) } }
                    .accessibilityIdentifier("offline-on-again")
            default:
                EmptyView()
            }
        } header: {
            Text(PassStrings.settingsOffline)
        } footer: {
            Text(PassStrings.settingsOfflineFooter)
        }
        .task(id: offline.copy?.syncedAt) {
            if offline.status == .ready, let list = try? await offline.devices() { devices = list }
        }

        if !devices.isEmpty {
            Section(PassStrings.settingsDevices) {
                ForEach(devices, id: \.id) { device in
                    let thisPhone = device.id == offline.deviceID
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name)
                            Text(deviceLine(device, thisPhone: thisPhone)).font(.inter(.subheadline)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !thisPhone {
                            Button(PassStrings.settingsRemoveDevice, role: .destructive) { removing = device }
                                .buttonStyle(.borderless)
                        }
                    }
                }
            }
            .confirmationDialog(
                PassStrings.settingsRemoveDeviceTitle(name: removing?.name ?? ""),
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                titleVisibility: .visible
            ) {
                Button(PassStrings.settingsRemoveDevice, role: .destructive) { remove() }
                Button(PassStrings.commonCancel, role: .cancel) { removing = nil }
            } message: {
                Text(PassStrings.settingsRemoveDeviceMessage)
            }
        }
    }

    private var statusLine: String {
        switch offline.status {
        case .ready:
            if offline.syncing { return PassStrings.settingsOfflineSyncing }
            guard let copy = offline.copy, !copy.syncedAt.isEmpty else { return PassStrings.settingsOfflineSyncing }
            return offline.isOffline
                ? PassStrings.settingsOfflineNoConnection(time: formatWhen(copy.syncedAt))
                : PassStrings.settingsOfflineReady(time: formatWhen(copy.syncedAt))
        case .locked: return PassStrings.settingsOfflineLocked
        case .unavailable: return PassStrings.settingsOfflineUnavailable
        case .disabled: return PassStrings.settingsOfflineDisabled
        case .revoked: return PassStrings.settingsOfflineRevoked
        case .off: return PassStrings.settingsOfflineOff
        }
    }

    private func deviceLine(_ device: Components.Schemas.Device, thisPhone: Bool) -> String {
        let synced = device.lastSyncAt.map { PassStrings.settingsLastSync(time: formatWhen($0)) } ?? PassStrings.settingsNeverSynced
        return thisPhone ? "\(PassStrings.settingsThisPhone) · \(synced)" : synced
    }

    private func remove() {
        guard let device = removing else { return }
        removing = nil
        Task {
            do {
                try await offline.revoke(deviceID: device.id)
                devices.removeAll { $0.id == device.id }
                toast.show(PassStrings.settingsRemoved)
            } catch {
                toast.show(passErrorMessage(error as? APIError))
            }
        }
    }
}
