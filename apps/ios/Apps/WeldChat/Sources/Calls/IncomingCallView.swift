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
            ChatAvatar(name: ring.callerName, url: ring.callerAvatar, size: 128)
            Text(callerName)
                .font(.inter(.title2, weight: .semibold))
                .multilineTextAlignment(.center)
                .lineLimit(2)
            Text(ring.callType == .video ? ChatStrings.callIncomingVideo : ChatStrings.callIncomingVoice)
                .font(.inter(.subheadline))
                .foregroundStyle(Tokens.Palette.mutedForeground)
            Spacer()
            HStack(spacing: 72) {
                RingButton(
                    symbol: "phone.down.fill",
                    color: CallStyle.decline,
                    label: ChatStrings.callDecline,
                    identifier: "incoming-decline",
                    action: onDecline
                )
                RingButton(
                    symbol: ring.callType == .video ? "video.fill" : "phone.fill",
                    color: CallStyle.accept,
                    label: ChatStrings.callAccept,
                    identifier: "incoming-accept",
                    action: onAccept
                )
            }
            .padding(.bottom, 48)
        }
        .padding(.horizontal, Tokens.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.Palette.background.ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }
}

/// The platform's ring button (a rounded square, `rounded-[13px]` at 36pt) with its label underneath.
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
                    .font(.system(size: 28))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(color, in: RoundedRectangle(cornerRadius: 26))
                Text(label)
                    .font(.inter(.footnote, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
