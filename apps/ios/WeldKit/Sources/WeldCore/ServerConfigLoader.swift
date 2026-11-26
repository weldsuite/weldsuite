import CoreAPI
import Foundation

/// A server's `/config.json`, fresh or from the last good copy on the phone.
public enum ConfigResult: Sendable {
    case loaded(Components.Schemas.RuntimeConfig, fromCache: Bool)
    case problem(ServerProblem)
}

/// Reads `<origin>/config.json`. The last good copy is kept, so the app
/// opens offline; an answer that isn't a WeldSuite document is never cached.
public struct ServerConfigLoader: Sendable {
    private let cache: Cache
    private let session: URLSession

    public init(cache: Cache = Cache()) {
        self.cache = cache
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        session = URLSession(configuration: configuration)
    }

    public func load(_ origin: URL) async -> ConfigResult {
        let key = "weldsuite:config:\(storageID(for: origin))"
        switch await fetch(origin) {
        case let .ok(config, raw):
            cache.set(raw, for: key)
            return .loaded(config, fromCache: false)
        case .notWeldSuite:
            return .problem(.notWeldSuite)
        case .unreachable:
            if let raw = cache.data(for: key), let config = parse(raw) {
                return .loaded(config, fromCache: true)
            }
            return .problem(.unreachable)
        }
    }

    private enum Fetched {
        case ok(Components.Schemas.RuntimeConfig, Data)
        case notWeldSuite
        case unreachable
    }

    private func fetch(_ origin: URL) async -> Fetched {
        var request = URLRequest(url: origin.appendingPathComponent("config.json"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            if http.statusCode == 404 { return .notWeldSuite }
            guard (200..<300).contains(http.statusCode) else { return .unreachable }
            guard http.value(forHTTPHeaderField: "Content-Type")?.contains("json") == true,
                  let config = parse(data), config.backend == "rust"
            else { return .notWeldSuite }
            return .ok(config, data)
        } catch {
            return .unreachable
        }
    }

    private func parse(_ data: Data) -> Components.Schemas.RuntimeConfig? {
        try? JSONDecoder().decode(Components.Schemas.RuntimeConfig.self, from: data)
    }
}
