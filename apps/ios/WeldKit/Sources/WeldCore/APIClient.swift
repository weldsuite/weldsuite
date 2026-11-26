import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// What an API call needs from the session.
public protocol APIAuth: Sendable {
    func token() async -> String?
    func refreshedToken() async -> String?
    func workspaceID() async -> String?
}

/// Adds the bearer token, `X-Weld-App` and, except on the workspace list
/// itself, `X-Weld-Workspace` to every request. A 401 refreshes the token
/// once and tries again.
public struct WeldHeadersMiddleware: ClientMiddleware {
    let appCode: String
    let auth: any APIAuth

    public init(appCode: String, auth: any APIAuth) {
        self.appCode = appCode
        self.auth = auth
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[.accept] = "application/json"
        request.headerFields[Self.app] = appCode
        if operationID != "listWorkspaces", let workspace = await auth.workspaceID() {
            request.headerFields[Self.workspace] = workspace
        }
        let token = await auth.token()
        if let token { request.headerFields[.authorization] = "Bearer \(token)" }
        let (response, responseBody) = try await next(request, body, baseURL)
        guard response.status.code == 401, token != nil, let fresh = await auth.refreshedToken() else {
            return (response, responseBody)
        }
        request.headerFields[.authorization] = "Bearer \(fresh)"
        return try await next(request, body, baseURL)
    }

    private static let app = HTTPField.Name("X-Weld-App")!
    private static let workspace = HTTPField.Name("X-Weld-Workspace")!
}

/// A failed API call. `status` is nil when the server wasn't reached; `code`
/// is the server's error code (`CRYPTO_ERROR`, …) when it sent one.
public struct APIError: Error, Equatable, Sendable {
    public let status: Int?
    public let code: String?

    public init(status: Int?, code: String?) {
        self.status = status
        self.code = code
    }

    public var isNetwork: Bool { status == nil }

    /// An error the generated client threw: a network failure, or anything else.
    public static func from(_ error: Error) -> APIError {
        if let api = error as? APIError { return api }
        if let client = error as? ClientError, client.underlyingError is URLError {
            return APIError(status: nil, code: nil)
        }
        if error is URLError { return APIError(status: nil, code: nil) }
        return APIError(status: 0, code: nil)
    }
}

/// The transport and middleware every generated client uses.
public struct APIConfiguration: Sendable {
    public let serverURL: URL
    public let transport: any ClientTransport
    public let middlewares: [any ClientMiddleware]

    public init(serverURL: URL, appCode: String, auth: any APIAuth) {
        self.serverURL = serverURL
        transport = URLSessionTransport()
        middlewares = [WeldHeadersMiddleware(appCode: appCode, auth: auth)]
    }
}
