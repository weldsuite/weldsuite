import Foundation

/// The signed-in person, from the ID token.
public struct Person: Codable, Equatable, Sendable {
    public let id: String
    public let name: String?
    public let email: String?

    public init(id: String, name: String?, email: String?) {
        self.id = id
        self.name = name
        self.email = email
    }
}

/// A workspace from `GET /api/workspaces`; `id` is `workspaces.id`.
public struct WorkspaceRef: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let slug: String?

    public init(id: String, name: String, slug: String? = nil) {
        self.id = id
        self.name = name
        self.slug = slug
    }
}

/// The claims of a JWT, unverified: only for reading the person after AppAuth checked the token.
func jwtClaims(_ token: String?) -> [String: Any]? {
    guard let token else { return nil }
    let parts = token.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while payload.count % 4 != 0 { payload += "=" }
    guard let data = Data(base64Encoded: payload) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func person(fromClaims claims: [String: Any]?) -> Person? {
    func string(_ key: String) -> String? {
        guard let value = claims?[key] as? String, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }
    guard let sub = string("sub") else { return nil }
    let given = [string("given_name"), string("family_name")].compactMap { $0 }.joined(separator: " ")
    return Person(id: sub, name: string("name") ?? (given.isEmpty ? nil : given), email: string("email"))
}

/// The active workspace after reading a fresh list: the current choice while
/// it's listed (or when it was made after the read began, for a workspace
/// created meanwhile); with none, a sole workspace is chosen without asking.
public func chooseActiveWorkspace(
    _ list: [WorkspaceRef],
    current: String?,
    chosenAfterReadStarted: Bool
) -> String? {
    let ids = Set(list.map(\.id))
    if let current, ids.contains(current) || chosenAfterReadStarted { return current }
    return list.count == 1 ? list[0].id : nil
}
