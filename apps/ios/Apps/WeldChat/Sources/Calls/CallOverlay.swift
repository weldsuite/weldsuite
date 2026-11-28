import LiveKit
import SwiftUI
import WeldCore
import WeldUI

/// The call over the whole app (port of the Expo app's `CallHost` and
/// `InCallRoom`): the app's own ring screen, the full-screen call, or, once
/// minimized, the bar at the top while the person moves through the app.
/// Not a screen of its own, so the call survives navigation.
struct CallOverlay: View {
    let manager: CallManager
    let onOpenChat: (_ channelID: String, _ isDirect: Bool) -> Void
    @Environment(Toaster.self) private var toaster: Toaster?

    init(manager: CallManager, onOpenChat: @escaping (_ channelID: String, _ isDirect: Bool) -> Void) {
        self.manager = manager
        self.onOpenChat = onOpenChat
    }

    var body: some View {
        content
            .animation(.easeInOut(duration: 0.25), value: manager.minimized)
            .animation(.easeInOut(duration: 0.25), value: manager.session?.callID)
            .onChange(of: manager.notice) { _, notice in
                guard let notice else { return }
                toaster?.show(notice)
                manager.clearNotice()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let ring = manager.incoming {
            IncomingCallView(
                ring: ring,
                onAccept: { manager.acceptIncoming() },
                onDecline: { manager.declineIncoming() }
            )
            .transition(.opacity)
        } else if let session = manager.session {
            if manager.minimized {
                VStack(spacing: 0) {
                    MinimizedCallBar(manager: manager, session: session)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            } else {
                InCallView(manager: manager, session: session) { openChat(session) }
                    .transition(.move(edge: .bottom))
            }
        }
    }

    /// The call goes on in the bar; its chat opens underneath.
    private func openChat(_ session: CallSession) {
        manager.minimize()
        onOpenChat(session.channelID, session.isDirect)
    }
}

/// The full-screen call, as WhatsApp lays it out: minimize top left, the chat
/// top right, who you're calling and how it's going, the media, then
/// WeldMeet's control bar.
private struct InCallView: View {
    let manager: CallManager
    let session: CallSession
    let onOpenChat: () -> Void

    private var isVideo: Bool { session.callType == .video }

    private var title: String {
        if let name = session.peerName, !name.isEmpty { return name }
        return isVideo ? ChatStrings.inCallVideoCall : ChatStrings.inCallVoiceCall
    }

    var body: some View {
        VStack(spacing: Tokens.Spacing.m) {
            header
            stage
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            controls
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.bottom, Tokens.Spacing.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.Palette.background.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("call-overlay")
    }

    private var header: some View {
        VStack(spacing: Tokens.Spacing.xs) {
            HStack {
                Button(action: { manager.minimize() }) {
                    Image(systemName: "chevron.down")
                        .font(.inter(.title3, weight: .semibold))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(ChatStrings.inCallMinimize)
                .accessibilityIdentifier("call-minimize")
                Spacer()
                Button(action: onOpenChat) {
                    Image(systemName: "message")
                        .font(.inter(.title3))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(ChatStrings.inCallBackToChat)
                .accessibilityIdentifier("call-back-to-chat")
            }
            .foregroundStyle(Tokens.Palette.foreground)
            Text(title)
                .font(.inter(.title2, weight: .semibold))
                .lineLimit(1)
            Text(manager.statusText)
                .font(.inter(.subheadline))
                .monospacedDigit()
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var stage: some View {
        let remotes = manager.tiles.filter { !$0.isLocal }
        let local = manager.tiles.first { $0.isLocal }
        ZStack(alignment: .bottomTrailing) {
            if isVideo, !remotes.isEmpty {
                VideoGrid(tiles: remotes)
            } else {
                VStack(spacing: Tokens.Spacing.l) {
                    avatar
                    if !manager.roomJoined {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let local {
                SwiftUIVideoView(local.track)
                    .frame(width: 112, height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                    .padding(Tokens.Spacing.s)
            }
        }
    }

    @ViewBuilder
    private var avatar: some View {
        if session.isDirect {
            ChatAvatar(name: session.peerName, url: session.peerAvatar, size: 140)
        } else {
            Image(systemName: "number")
                .font(.system(size: 56, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 140, height: 140)
                .background(Tokens.Palette.muted, in: AvatarShape())
                .accessibilityHidden(true)
        }
    }

    /// The platform's call controls: `rounded-[18px]` 48pt squares, centred, Leave a little wider.
    private var controls: some View {
        HStack(spacing: Tokens.Spacing.s) {
            ControlButton(
                symbol: manager.micEnabled ? "mic.fill" : "mic.slash.fill",
                isOn: manager.micEnabled,
                label: manager.micEnabled ? ChatStrings.inCallTurnOffMic : ChatStrings.inCallTurnOnMic,
                identifier: "call-mic",
                action: { manager.toggleMic() }
            )
            if isVideo {
                ControlButton(
                    symbol: manager.cameraEnabled ? "video.fill" : "video.slash.fill",
                    isOn: manager.cameraEnabled,
                    label: manager.cameraEnabled ? ChatStrings.inCallTurnOffCamera : ChatStrings.inCallTurnOnCamera,
                    identifier: "call-camera",
                    action: { manager.toggleCamera() }
                )
            }
            Menu {
                if isVideo {
                    Button(action: { manager.flipCamera() }) {
                        Label(ChatStrings.inCallFlipCamera, systemImage: "arrow.triangle.2.circlepath.camera")
                    }
                }
                Button(action: onOpenChat) {
                    Label(ChatStrings.inCallBackToChat, systemImage: "message")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 18))
                    .frame(width: 48, height: 48)
                    .background(Tokens.Palette.secondary, in: RoundedRectangle(cornerRadius: CallStyle.radius))
                    .overlay(RoundedRectangle(cornerRadius: CallStyle.radius).stroke(Tokens.Palette.border, lineWidth: 1))
                    .foregroundStyle(Tokens.Palette.foreground)
            }
            .accessibilityLabel(ChatStrings.inCallMoreOptions)
            .accessibilityIdentifier("call-more")
            Button(action: { manager.hangUp() }) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 18))
                    .frame(width: 64, height: 48)
                    .background(Tokens.Status.danger, in: RoundedRectangle(cornerRadius: CallStyle.radius))
                    .foregroundStyle(.white)
            }
            .accessibilityLabel(ChatStrings.inCallLeaveCall)
            .accessibilityIdentifier("call-leave")
        }
    }
}

/// The call screens' colours, as the platform's: the live call strip (its
/// active-call banner: `green-500/10`, a `green-500/20` line, `green-700`
/// text), a control that is off (`bg-red-100 text-red-500`), and the ring's
/// Decline and Accept (`bg-red-600`, `bg-green-600`).
enum CallStyle {
    static let radius: CGFloat = 18
    static let barFill = ChatColors.dynamic(0x22C55E, 0x22C55E, lightOpacity: 0.1, darkOpacity: 0.05)
    static let barLine = Color(hex: 0x22C55E).opacity(0.2)
    static let barText = ChatColors.dynamic(0x15803D, 0x4ADE80)
    static let offFill = ChatColors.dynamic(0xFEE2E2, 0xEF4444, darkOpacity: 0.2)
    static let offText = ChatColors.dynamic(0xEF4444, 0xF87171)
    static let decline = Color(hex: 0xDC2626)
    static let accept = Color(hex: 0x16A34A)
}

/// A 48 pt `rounded-[18px]` square of the control bar: the platform's
/// secondary button with a ring, red-tinted while it's off.
private struct ControlButton: View {
    let symbol: String
    let isOn: Bool
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18))
                .frame(width: 48, height: 48)
                .background(isOn ? Tokens.Palette.secondary : CallStyle.offFill, in: RoundedRectangle(cornerRadius: CallStyle.radius))
                .overlay(RoundedRectangle(cornerRadius: CallStyle.radius).stroke(isOn ? Tokens.Palette.border : Color.clear, lineWidth: 1))
                .foregroundStyle(isOn ? Tokens.Palette.foreground : CallStyle.offText)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// The other people's cameras: one fills the stage, more share it in two columns.
private struct VideoGrid: View {
    let tiles: [VideoTile]

    var body: some View {
        GeometryReader { proxy in
            let columns = tiles.count > 2 ? 2 : 1
            let rows = (tiles.count + columns - 1) / columns
            let spacing = Tokens.Spacing.s
            let height = max(80, (proxy.size.height - spacing * CGFloat(rows - 1)) / CGFloat(max(rows, 1)))
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: spacing), count: columns),
                spacing: spacing
            ) {
                ForEach(tiles) { tile in
                    SwiftUIVideoView(tile.track)
                        .frame(height: height)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                        .accessibilityLabel(tile.name ?? "")
                }
            }
        }
    }
}

/// The call while it is minimized, as the platform's live-call strip: a
/// green wash, mute on the left, the name and status in green, the red
/// hang-up on the right. Tapping the middle brings the call back.
private struct MinimizedCallBar: View {
    let manager: CallManager
    let session: CallSession

    private var title: String {
        if let name = session.peerName, !name.isEmpty {
            return ChatStrings.callBarTitle(name: name, status: manager.statusText)
        }
        return manager.statusText
    }

    var body: some View {
        let muted = !manager.micEnabled
        HStack(spacing: Tokens.Spacing.m) {
            Button(action: { manager.toggleMic() }) {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 15))
                    .frame(width: 38, height: 38)
                    .background(muted ? CallStyle.offFill : Tokens.Palette.secondary, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(muted ? Color.clear : Tokens.Palette.border, lineWidth: 1))
                    .foregroundStyle(muted ? CallStyle.offText : Tokens.Palette.foreground)
            }
            .accessibilityLabel(muted ? ChatStrings.callUnmute : ChatStrings.callMute)
            .accessibilityIdentifier("call-bar-mute")
            Button(action: { manager.expand() }) {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: "phone.fill")
                        .font(.inter(.footnote))
                    Text(title)
                        .font(.inter(.subheadline, weight: .semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .foregroundStyle(CallStyle.barText)
                .frame(maxWidth: .infinity, minHeight: 38)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(ChatStrings.callReturnToCall)
            .accessibilityIdentifier("call-bar")
            Button(action: { manager.hangUp() }) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 15))
                    .frame(width: 38, height: 38)
                    .background(Tokens.Status.danger, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(Color.white)
            }
            .accessibilityLabel(ChatStrings.callEndCall)
            .accessibilityIdentifier("call-bar-end")
        }
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.vertical, Tokens.Spacing.xs + 2)
        .background(CallStyle.barFill, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.xlarge).stroke(CallStyle.barLine, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, Tokens.Spacing.xs)
    }
}
