import AuthenticationServices
import UIKit

/// WeldPass in iOS's password AutoFill (ADR PASS-010).
///
/// Everything comes from the app's offline copy: no network, no tokens, so
/// the app's rotating refresh token never leaves the app. Every fill asks for
/// Face ID or the passcode, because the copy's key is behind them. Fills are
/// queued for the vault's trail; the app uploads them at its next sync.
final class CredentialProviderViewController: ASCredentialProviderViewController,
    UITableViewDataSource, UITableViewDelegate
{
    private var logins: [Login] = []
    private var hosts: [String] = []
    // The platform's list: plain rows on the background with full-width hairlines.
    private let table = UITableView(frame: .zero, style: .plain)
    private let message = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background
        table.dataSource = self
        table.delegate = self
        table.backgroundColor = Palette.background
        table.separatorColor = Palette.border
        table.separatorInset = .zero
        table.tableFooterView = UIView()
        table.translatesAutoresizingMaskIntoConstraints = false
        message.translatesAutoresizingMaskIntoConstraints = false
        message.numberOfLines = 0
        message.textAlignment = .center
        message.font = .preferredFont(forTextStyle: .subheadline)
        message.textColor = Palette.mutedForeground
        // The extension has no navigation bar of its own: a plain Cancel button.
        let cancelButton = UIButton(type: .system)
        cancelButton.tintColor = Palette.primary
        cancelButton.setTitle(PassStrings.commonCancel, for: .normal)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)
        view.addSubview(table)
        view.addSubview(message)
        NSLayoutConstraint.activate([
            cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            cancelButton.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            table.topAnchor.constraint(equalTo: cancelButton.bottomAnchor, constant: 4),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            message.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            message.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    // MARK: - AutoFill entry points

    /// The "Passwords" list for the page or app being filled.
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        hosts = serviceIdentifiers.compactMap { HostMatch.host(of: $0.identifier) }
        load()
    }

    /// A suggestion picked straight from the QuickType bar: the key needs Face ID,
    /// so this always asks for the interface.
    override func provideCredentialWithoutUserInteraction(for _: ASPasswordCredentialIdentity) {
        extensionContext.cancelRequest(withError: NSError(
            domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue
        ))
    }

    override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
        guard let all = unlockedLogins() else { return }
        if let login = all.first(where: { $0.recordIdentifier == credentialIdentity.recordIdentifier }) {
            complete(with: login)
        } else {
            // Gone since the suggestion was made (deleted, or the vault left).
            extensionContext.cancelRequest(withError: NSError(
                domain: ASExtensionErrorDomain, code: ASExtensionError.credentialIdentityNotFound.rawValue
            ))
        }
    }

    // MARK: - The list

    private func load() {
        guard let all = unlockedLogins() else { return }
        let matching = all.filter { login in
            guard let host = login.host else { return false }
            return hosts.contains { HostMatch.matches(host, $0) }
        }
        // Matching logins first; with none, everything, so a login saved under
        // another address can still be picked.
        logins = matching.isEmpty ? all : matching
        if message.text == nil, logins.isEmpty { message.text = PassStrings.autofillEmpty }
        table.reloadData()
    }

    /// The copies' logins, after Face ID. Nil when the request was ended.
    private func unlockedLogins() -> [Login]? {
        do {
            let key = try SharedCopy.readKey(reason: PassStrings.autofillUnlockReason)
            return SharedCopy.logins(key: key)
        } catch SharedCopy.Failure.cancelled {
            cancel()
            return nil
        } catch {
            message.text = PassStrings.autofillNoCopy
            return []
        }
    }

    private func complete(with login: Login) {
        SharedCopy.recordFill(login)
        extensionContext.completeRequest(
            withSelectedCredential: ASPasswordCredential(user: login.username, password: login.password),
            completionHandler: nil
        )
    }

    @objc private func cancel() {
        extensionContext.cancelRequest(withError: NSError(
            domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue
        ))
    }

    func tableView(_: UITableView, numberOfRowsInSection _: Int) -> Int {
        logins.count
    }

    /// A login as the app's list shows one: the login's globe, the title, and
    /// the username and site under it.
    func tableView(_: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        let login = logins[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.image = UIImage(systemName: "globe")
        content.imageProperties.tintColor = Palette.mutedForeground
        content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15)
        content.text = login.title
        content.textProperties.font = UIFontMetrics(forTextStyle: .subheadline)
            .scaledFont(for: .systemFont(ofSize: 15, weight: .medium))
        content.textProperties.color = Palette.foreground
        content.textProperties.numberOfLines = 1
        content.secondaryText = [login.username, login.host ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        content.secondaryTextProperties.font = .preferredFont(forTextStyle: .footnote)
        content.secondaryTextProperties.color = Palette.mutedForeground
        content.secondaryTextProperties.numberOfLines = 1
        cell.contentConfiguration = content
        cell.backgroundColor = Palette.background
        return cell
    }

    func tableView(_: UITableView, didSelectRowAt indexPath: IndexPath) {
        complete(with: logins[indexPath.row])
    }
}

/// The platform's colours the extension uses. It doesn't link WeldUI, so
/// these repeat `Tokens.Palette` (from `apps/mobile-shared/tokens.json`).
private enum Palette {
    static let background = dynamic(light: 0xFFFFFF, dark: 0x1C1D1F)
    static let foreground = dynamic(light: 0x0A0A0A, dark: 0xFFFFFF)
    static let mutedForeground = dynamic(light: 0x737373, dark: 0xB5BDC9)
    static let border = dynamic(light: 0xE5E5E5, dark: 0x2E3238)
    static let primary = dynamic(light: 0x171717, dark: 0x266DF0)

    private static func dynamic(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1
            )
        }
    }
}
