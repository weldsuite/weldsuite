import SwiftUI
import WeldCore

/// How the app presents itself on the screens around it.
public struct AppBranding {
    public let name: String
    public let subtitle: String
    /// An image in the app's asset catalog.
    public let logo: String

    public init(name: String, subtitle: String, logo: String) {
        self.name = name
        self.subtitle = subtitle
        self.logo = logo
    }
}

/// Everything between launch and the app's own screens: the server check,
/// the update gate, WeldID sign-in, the workspace choice and the app lock.
/// Shows `content` only for a signed-in person in a workspace, unlocked.
public struct SessionGate<Content: View>: View {
    let env: AppEnvironment
    let branding: AppBranding
    let content: (_ person: Person, _ workspace: WorkspaceRef, _ workspaces: [WorkspaceRef]) -> Content

    public init(
        env: AppEnvironment,
        branding: AppBranding,
        @ViewBuilder content: @escaping (_ person: Person, _ workspace: WorkspaceRef, _ workspaces: [WorkspaceRef]) -> Content
    ) {
        self.env = env
        self.branding = branding
        self.content = content
    }

    public var body: some View {
        Group {
            switch env.state {
            case .booting:
                ProgressView()
            case let .serverUnavailable(problem, server):
                MessageView(
                    title: branding.name,
                    message: problemText(problem, server: server),
                    primary: (CoreStrings.commonTryAgain, { Task { await env.start() } })
                )
            case let .updateRequired(storeURL):
                MessageView(
                    title: CoreStrings.updateTitle(app: branding.name),
                    message: CoreStrings.updateDescription(app: branding.name),
                    primary: (CoreStrings.updateButton, { UIApplication.shared.open(storeURL) })
                )
            case .signedOut:
                SignInView(env: env, branding: branding)
            case let .choosingWorkspace(_, loading, workspaces):
                WorkspaceChoiceView(env: env, loading: loading, workspaces: workspaces)
            case let .ready(person, workspace, workspaces):
                if env.lock.isRequired, !env.lock.hasScreenLock {
                    MessageView(
                        title: CoreStrings.lockNoScreenLockTitle,
                        message: CoreStrings.lockNoScreenLockDescription(app: branding.name),
                        primary: (CoreStrings.lockOpenSettings, {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        })
                    )
                } else if env.lock.isLocked {
                    LockView(lock: env.lock, branding: branding)
                } else {
                    content(person, workspace, workspaces)
                        .modifier(EnterWorkspace(env: env, workspace: workspace.id))
                }
            }
        }
        .modifier(StartEnvironment(env: env))
        .weldStyle()
    }

    private func problemText(_ problem: ServerProblem, server: String) -> String {
        switch problem {
        case .unreachable: CoreStrings.serverUnreachable(server: server)
        case .notWeldSuite: CoreStrings.serverNotWeldsuite(server: server)
        case .noMobileSignIn: CoreStrings.serverNoMobileSignIn(server: server)
        case .appUnavailable: CoreStrings.serverAppUnavailable(app: branding.name, server: server)
        }
    }
}

// SessionGate is generic over the app's content, so a release build
// specializes its body inside the app. SwiftUI's `task` modifiers there
// (Xcode 26's back-deployed `task(id:name:priority:…)`) then need the
// back-deployment copy the compiler only emits into a module that calls
// `task` itself: an app that never does (WeldDesk) fails to link. Private
// modifiers keep the `task` calls compiled here.

/// Tells the environment which workspace the person is in.
private struct EnterWorkspace: ViewModifier {
    let env: AppEnvironment
    let workspace: String

    func body(content: Content) -> some View {
        content.task(id: workspace) { await env.didEnterWorkspace(workspace) }
    }
}

/// Loads the server and the session the first time the gate shows.
private struct StartEnvironment: ViewModifier {
    let env: AppEnvironment

    func body(content: Content) -> some View {
        content.task { if case .booting = env.state, env.session == nil { await env.start() } }
    }
}

/// A full screen with a title, an explanation and up to two actions.
public struct MessageView: View {
    let title: String
    let message: String?
    var primary: (String, () -> Void)?
    var secondary: (String, () -> Void)?

    public init(title: String, message: String?, primary: (String, () -> Void)? = nil, secondary: (String, () -> Void)? = nil) {
        self.title = title
        self.message = message
        self.primary = primary
        self.secondary = secondary
    }

    public var body: some View {
        VStack(spacing: Tokens.Spacing.m) {
            Text(title).font(.inter(.title2, weight: .bold)).multilineTextAlignment(.center)
            if let message {
                Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            if let primary {
                Button(primary.0, action: primary.1)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .padding(.top, Tokens.Spacing.s)
            }
            if let secondary {
                Button(secondary.0, action: secondary.1)
            }
        }
        .padding(Tokens.Spacing.xl)
        .frame(maxWidth: 420)
    }
}

private struct SignInView: View {
    let env: AppEnvironment
    let branding: AppBranding
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: Tokens.Spacing.m) {
            Image(branding.logo)
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
            Text(branding.name).font(.inter(.largeTitle, weight: .bold))
            Text(branding.subtitle).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let error {
                Text(error).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Button {
                start(createAccount: false)
            } label: {
                Text(CoreStrings.signInButton).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)
            .padding(.top, Tokens.Spacing.l)
            .accessibilityIdentifier("sign-in")
            Button(CoreStrings.signInCreateAccount) { start(createAccount: true) }
                .disabled(busy)
                .accessibilityIdentifier("create-account")
            Text(CoreStrings.signInServer(server: env.serverName))
                .font(.inter(.footnote))
                .foregroundStyle(.secondary)
        }
        .padding(Tokens.Spacing.xl)
        .frame(maxWidth: 420)
    }

    private func start(createAccount: Bool) {
        busy = true
        error = nil
        Task {
            switch await env.signIn(createAccount: createAccount) {
            case .signedIn, .cancelled: error = nil
            case .unreachable: error = CoreStrings.signInUnreachable
            case .failed: error = CoreStrings.signInFailed
            }
            busy = false
        }
    }
}

private struct WorkspaceChoiceView: View {
    let env: AppEnvironment
    let loading: Bool
    let workspaces: [WorkspaceRef]

    var body: some View {
        if loading && workspaces.isEmpty {
            VStack(spacing: Tokens.Spacing.m) {
                ProgressView()
                Text(CoreStrings.workspaceLoading).foregroundStyle(.secondary)
            }
        } else if workspaces.isEmpty {
            MessageView(
                title: CoreStrings.workspaceNoneTitle,
                message: CoreStrings.workspaceNoneDescription,
                primary: (CoreStrings.workspaceCheckAgain, { Task { await env.reloadWorkspaces() } }),
                secondary: (CoreStrings.commonSignOut, { Task { await env.signOut() } })
            )
        } else {
            NavigationStack {
                WorkspacePicker(workspaces: workspaces) { env.chooseWorkspace($0) }
            }
        }
    }
}

/// The person's workspaces, to pick one. Also used from an app's settings to switch.
public struct WorkspacePicker: View {
    let workspaces: [WorkspaceRef]
    let onChoose: (String) -> Void

    public init(workspaces: [WorkspaceRef], onChoose: @escaping (String) -> Void) {
        self.workspaces = workspaces
        self.onChoose = onChoose
    }

    public var body: some View {
        List(workspaces) { workspace in
            Button {
                onChoose(workspace.id)
            } label: {
                HStack {
                    Text(workspace.name).foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
            }
            .accessibilityIdentifier("workspace-\(workspace.name)")
        }
        .navigationTitle(CoreStrings.workspaceChoose)
    }
}

private struct LockView: View {
    let lock: AppLock
    let branding: AppBranding

    var body: some View {
        MessageView(
            title: CoreStrings.lockTitle(app: branding.name),
            message: nil,
            primary: (CoreStrings.lockUnlock, unlock)
        )
        // Ask straight away; the button is for when the person dismissed the prompt.
        .task { unlock() }
    }

    private func unlock() {
        Task { _ = await lock.unlock(reason: CoreStrings.lockTitle(app: branding.name)) }
    }
}
