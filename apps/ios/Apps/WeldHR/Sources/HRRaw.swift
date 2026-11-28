import Foundation
import WeldCore

/// The caller's effective permissions in the workspace; denies always win.
struct HRPermissions: Decodable {
    let permissions: [String]?
    let denies: [String]?
}

private struct HRPermissionsEnvelope: Decodable {
    let data: HRPermissions
}

/// The calls weldhr.yaml can't describe, with the same headers as the
/// generated client (the bearer token, `X-Weld-App`, `X-Weld-Workspace`; a
/// 401 refreshes the token once): the contract checker reads JSON only, so
/// the receipt upload (multipart) and the files the app opens are here, and
/// `GET /api/me/permissions`, which the server's binary serves rather than
/// the WeldHR module. Could move to WeldCore (an authorised raw request).
@MainActor
struct HRRaw {
    let env: AppEnvironment

    private static let cacheFolder = "weldhr-documents"

    private func makeRequest(_ path: String, method: String = "GET", token: String?) throws -> URLRequest {
        let base = env.serverURL.absoluteString.hasSuffix("/") ? env.serverURL.absoluteString : env.serverURL.absoluteString + "/"
        guard let root = URL(string: base), let url = URL(string: path, relativeTo: root) else {
            throw HRFailure(api: APIError(status: 0, code: nil), message: nil)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(env.app.code, forHTTPHeaderField: "X-Weld-App")
        if let workspace = env.session?.activeWorkspaceID { request.setValue(workspace, forHTTPHeaderField: "X-Weld-Workspace") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    /// Sends a request built by `build` (given the token), once more with a fresh token after a 401.
    private func send(_ build: (String?) throws -> URLRequest) async throws -> (Data, HTTPURLResponse) {
        let token = await env.session?.token()
        var (data, response) = try await perform(try build(token))
        if response.statusCode == 401, token != nil, let fresh = await env.session?.refreshedToken() {
            (data, response) = try await perform(try build(fresh))
        }
        guard (200 ..< 300).contains(response.statusCode) else {
            let error = try? JSONDecoder().decode(HRErrorEnvelope.self, from: data)
            throw HRFailure(api: APIError(status: response.statusCode, code: error?.error.code), message: error?.error.message)
        }
        return (data, response)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw HRFailure(api: APIError(status: 0, code: nil), message: nil) }
            return (data, http)
        } catch let failure as HRFailure {
            throw failure
        } catch {
            throw HRFailure(api: APIError(status: nil, code: nil), message: nil)
        }
    }

    func permissions() async throws -> HRPermissions {
        let (data, _) = try await send { token in
            var request = try makeRequest("api/me/permissions", token: token)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            return request
        }
        return try JSONDecoder().decode(HRPermissionsEnvelope.self, from: data).data
    }

    /// Attach the receipt to the caller's own claim: multipart `file`.
    func uploadReceipt(declarationID: String, file: HRPickedFile) async throws {
        let boundary = "weldhr-\(UUID().uuidString)"
        var body = Data()
        let safeName = file.name.replacingOccurrences(of: "\"", with: "")
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(file.mimeType)\r\n\r\n".utf8))
        body.append(file.data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let id = declarationID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? declarationID
        _ = try await send { token in
            var request = try makeRequest("api/weldhr/me/declarations/\(id)/receipt", method: "POST", token: token)
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.httpBody = body
            return request
        }
    }

    /// Download a file under `/api` into the app's caches (the OS may clear them), for Quick Look.
    func download(path: String, fileName: String) async throws -> URL {
        let (data, _) = try await send { token in try makeRequest(path, token: token) }
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(Self.cacheFolder, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(Receipts.safeFileName(fileName))
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        return file
    }
}

private struct HRErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String?
        let message: String?
    }

    let error: Body
}
