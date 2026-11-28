import SwiftUI
import WeldCore

/// A person's picture, or their initials when there is none (or it doesn't
/// load): white on the colour the web platform gives that name, or in `tint`
/// on a light wash of it when one is passed.
public struct AvatarView: View {
    let name: String?
    let url: URL?
    var size: CGFloat
    var tint: Color?

    public init(name: String?, url: URL? = nil, size: CGFloat = 36, tint: Color? = nil) {
        self.name = name
        self.url = url
        self.size = size
        self.tint = tint
    }

    public var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var initials: some View {
        Text(Self.initials(of: name))
            .font(.inter(size: size * 0.38, weight: .semibold))
            .foregroundStyle(tint ?? .white)
            .frame(width: size, height: size)
            .background(tint?.opacity(0.15) ?? PlatformColors.avatar(name ?? ""))
    }

    /// "Ann de Vries" → "AV", "ann@example.com" → "A".
    public static func initials(of name: String?) -> String {
        let words = (name ?? "").split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." })
        guard let first = words.first?.first else { return "?" }
        guard words.count > 1, let last = words.last?.first, !(name ?? "").contains("@") else {
            return String(first).uppercased()
        }
        return (String(first) + String(last)).uppercased()
    }
}

/// A short coloured label: a status, a count, a priority.
public struct StatusBadge: View {
    let text: String
    let color: Color

    public init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
    }
}

/// A list that couldn't load, with a way to try again.
public struct LoadErrorView: View {
    let error: APIError?
    let retry: () async -> Void

    public init(error: APIError?, retry: @escaping () async -> Void) {
        self.error = error
        self.retry = retry
    }

    public var body: some View {
        ContentUnavailableView {
            Label(CoreStrings.errorsLoadFailed, systemImage: error?.isNetwork == true ? "wifi.slash" : "exclamationmark.triangle")
        } description: {
            Text(apiErrorMessage(error))
        } actions: {
            Button(CoreStrings.commonTryAgain) { Task { await retry() } }
                .accessibilityIdentifier("retry")
        }
    }
}

/// A short message at the bottom of the screen: "Saved", "Couldn't send".
/// One per app, put in the environment and shown with `.toastOverlay(_:)`.
@MainActor
@Observable
public final class Toaster {
    public private(set) var message: String?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    public init() {}

    public func show(_ text: String) {
        message = text
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { message = nil }
        }
    }

    /// The person-facing message for a failed call.
    public func show(_ error: APIError?) {
        show(apiErrorMessage(error))
    }
}

extension View {
    /// Shows the toaster's message over this view, and puts the toaster in the environment.
    public func toastOverlay(_ toaster: Toaster) -> some View {
        environment(toaster)
            .overlay(alignment: .bottom) {
                if let message = toaster.message {
                    Text(message)
                        .font(.inter(.subheadline))
                        .padding(.horizontal, Tokens.Spacing.l)
                        .padding(.vertical, Tokens.Spacing.m)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.bottom, 90)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityIdentifier("toast")
                }
            }
            .animation(.default, value: toaster.message)
    }
}

/// Reload while a screen is shown whenever the workspace hub says something
/// on `topics` changed (and after a reconnect).
///
/// ```swift
/// List { … }.realtimeRefresh(env, topics: ["ticket"]) { await store.load() }
/// ```
extension View {
    public func realtimeRefresh(_ env: AppEnvironment, topics: [String], action: @escaping () async -> Void) -> some View {
        modifier(RealtimeRefresh(env: env, topics: topics, action: action))
    }
}

/// The `task` behind `realtimeRefresh`, in a private modifier so it stays
/// compiled in WeldUI and is never inlined into an app: an app that doesn't
/// call `task(id:)` itself would then miss Xcode 26's back-deployed copy of it
/// and fail to link (see `EnterWorkspace` in SessionGate.swift).
private struct RealtimeRefresh: ViewModifier {
    let env: AppEnvironment
    let topics: [String]
    let action: () async -> Void

    func body(content: Content) -> some View {
        content.task(id: topics) {
            guard let realtime = env.realtime else { return }
            for await _ in realtime.events(topics) {
                await action()
            }
        }
    }
}
