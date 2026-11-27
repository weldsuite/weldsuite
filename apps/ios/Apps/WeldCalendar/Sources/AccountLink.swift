import Foundation
import WeldCore

/// The account page where a person deletes their account (`auth.accountUrl`
/// in the server's `/config.json`), which the core doesn't hand to the apps
/// yet. Nil when the server names none, or can't be reached.
enum AccountLink {
    static func accountURL(server: URL) async -> URL? {
        var request = URLRequest(url: server.appendingPathComponent("config.json"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return accountURL(fromConfig: data)
    }

    /// `auth.accountUrl` of a `/config.json` body, when it is an https link.
    static func accountURL(fromConfig data: Data) -> URL? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let auth = root["auth"] as? [String: Any],
              let text = auth["accountUrl"] as? String,
              text.hasPrefix("https://")
        else { return nil }
        return URL(string: text)
    }
}
