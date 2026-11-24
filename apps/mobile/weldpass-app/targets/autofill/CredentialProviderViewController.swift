import AuthenticationServices
import UIKit

/// WeldPass in iOS's password AutoFill (ADR PASS-010).
///
/// Everything comes from the app's offline copy: no network, no tokens, so
/// the app's rotating refresh token never leaves the app. Every fill asks
/// for Face ID or Touch ID, because the copy's key is behind them. Fills are
/// queued for the vault's trail; the app uploads them at its next sync.
final class CredentialProviderViewController: ASCredentialProviderViewController,
  UITableViewDataSource, UITableViewDelegate
{
  private var logins: [Login] = []
  private var hosts: [String] = []
  private let table = UITableView(frame: .zero, style: .insetGrouped)
  private let message = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    table.dataSource = self
    table.delegate = self
    table.translatesAutoresizingMaskIntoConstraints = false
    message.translatesAutoresizingMaskIntoConstraints = false
    message.numberOfLines = 0
    message.textAlignment = .center
    message.textColor = .secondaryLabel
    // The extension has no navigation bar of its own: a plain Cancel button.
    let cancelButton = UIButton(type: .system)
    cancelButton.setTitle(Strings.cancel, for: .normal)
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

  /// The QuickType bar's "Passwords" list for the page or app being filled.
  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    hosts = serviceIdentifiers.compactMap { HostMatch.host(of: $0.identifier) }
    load()
  }

  /// A suggestion picked straight from the QuickType bar: the key needs
  /// biometrics, so this always asks for the interface.
  override func provideCredentialWithoutUserInteraction(for _: ASPasswordCredentialIdentity) {
    extensionContext.cancelRequest(
      withError: NSError(
        domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
  }

  override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
    guard let all = unlockedLogins() else { return }
    if let login = all.first(where: { $0.recordIdentifier == credentialIdentity.recordIdentifier }) {
      complete(with: login)
    } else {
      // Gone since the suggestion was made (deleted, or the vault left).
      extensionContext.cancelRequest(
        withError: NSError(
          domain: ASExtensionErrorDomain, code: ASExtensionError.credentialIdentityNotFound.rawValue))
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
    message.text = logins.isEmpty ? Strings.empty : nil
    table.reloadData()
  }

  /// The copy's logins, after Face ID. Nil when the request was ended.
  private func unlockedLogins() -> [Login]? {
    do {
      let key = try OfflineCopy.readKey(reason: Strings.unlockReason)
      return OfflineCopy.logins(key: key)
    } catch OfflineCopy.Failure.cancelled {
      cancel()
      return nil
    } catch {
      message.text = Strings.noCopy
      return []
    }
  }

  private func complete(with login: Login) {
    OfflineCopy.recordFill(login)
    extensionContext.completeRequest(
      withSelectedCredential: ASPasswordCredential(user: login.username, password: login.password),
      completionHandler: nil)
  }

  @objc private func cancel() {
    extensionContext.cancelRequest(
      withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
  }

  func tableView(_: UITableView, numberOfRowsInSection _: Int) -> Int {
    logins.count
  }

  func tableView(_: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
    let login = logins[indexPath.row]
    cell.textLabel?.text = login.title
    cell.detailTextLabel?.text = [login.username, login.host ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    cell.detailTextLabel?.textColor = .secondaryLabel
    return cell
  }

  func tableView(_: UITableView, didSelectRowAt indexPath: IndexPath) {
    complete(with: logins[indexPath.row])
  }
}

/// The extension's few strings, in English and Dutch (the app's languages).
enum Strings {
  private static var dutch: Bool { Locale.preferredLanguages.first?.hasPrefix("nl") ?? false }

  static var cancel: String {
    dutch ? "Annuleren" : "Cancel"
  }

  static var unlockReason: String {
    dutch ? "Ontgrendel WeldPass om in te vullen" : "Unlock WeldPass to fill in"
  }

  static var empty: String {
    dutch ? "Geen logins in WeldPass." : "No logins in WeldPass."
  }

  static var noCopy: String {
    dutch
      ? "Open WeldPass en ontgrendel het één keer, dan kan het hier invullen."
      : "Open WeldPass and unlock it once, then it can fill in here."
  }
}
