import SwiftUI
import WeldCore
import WeldUI

/// The app's own ring screen (port of the Expo app's `IncomingCallModal`):
/// who calls, voice or video, Decline and Accept. Shown where CallKit isn't
/// allowed (mainland China); everywhere else CallKit rings.
struct IncomingCallView: View {
    let ring: IncomingCall
    let onAccept: () -> Void
    let onDecline: () -> Void

    private var callerName: String {
        ring.callerName ?? ChatStrings.callUnknownCaller
    }

    var body: some View {
        VStack(spacing: Tokens.Spacing.l) {
            Spacer()
            AvatarView(
                name: ring.callerName,
                url: ring.callerAvatar.flatMap(URL.init(string:)),
                size: 128,
                tint: Tokens.Brand.weldchat
            )
            Text(callerName)
                .font(.title.bold())
                .multilineTextAlignment(.center)
                .lineLimit(2)
            Text(ring.callType == .video ? ChatStrings.callIncomingVideo : ChatStrings.callIncomingVoice)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            HStack(spacing: 72) {
                RingButton(
                    symbol: "phone.down.fill",
                    color: Tokens.Status.danger,
                    label: ChatStrings.callDecline,
                    identifier: "incoming-decline",
                    action: onDecline
                )
                RingButton(
                    symbol: ring.callType == .video ? "video.fill" : "phone.fill",
                    color: Tokens.Status.success,
                    label: ChatStrings.callAccept,
                    identifier: "incoming-accept",
                    action: onAccept
                )
            }
            .padding(.bottom, 48)
        }
        .padding(.horizontal, Tokens.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }
}

/// A round button with its label underneath.
private struct RingButton: View {
    let symbol: String
    let color: Color
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Tokens.Spacing.s) {
                Image(systemName: symbol)
                    .font(.title)
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(color, in: Circle())
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
