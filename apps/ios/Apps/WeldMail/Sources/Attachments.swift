import Foundation
import UniformTypeIdentifiers
import WeldCore

/// A file picked in the composer, copied into the app's temporary folder, not uploaded yet.
struct PickedFile: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var url: URL
    var mimeType: String
    var size: Int
}

/// An attachment's bytes, both ways. Neither is JSON, so neither is in the
/// OpenAPI file: they go out with the same headers as every API call (the
/// session's token, `X-Weld-App`, `X-Weld-Workspace`), as on Android.
///
/// - Opening one downloads it through `GET /api/mail-attachments/{id}/download`
///   (the mailbox's access check; no public URL) into the app's caches, and
///   shows it in Quick Look.
/// - Attaching one asks `POST /api/storage/generate-upload-url` for a one-time
///   upload URL, `PUT`s the bytes there (without the session's headers: the
///   URL's token is the permission), and sends the storage key with the mail.
@MainActor
enum MailFiles {
    private struct UploadTarget: Decodable {
        let uploadUrl: String?
        let fileKey: String?
    }

    private struct UploadRequest: Encodable {
        let fileName: String
        let contentType: String
        let fileSize: Int
        let folder: String
    }

    /// Sends a request to the server with the session's headers; a 401 refreshes the token once.
    private static func authorised(_ base: URLRequest, env: AppEnvironment) async throws -> (Data, Int) {
        guard let session = env.session else { throw APIError(status: nil, code: nil) }
        var request = base
        request.setValue(env.app.code, forHTTPHeaderField: "X-Weld-App")
        if let workspace = session.activeWorkspaceID { request.setValue(workspace, forHTTPHeaderField: "X-Weld-Workspace") }
        var token = await session.token()
        for attempt in 0..<2 {
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let result: (Data, URLResponse)
            do {
                result = try await URLSession.shared.data(for: request)
            } catch {
                throw APIError(status: nil, code: nil)
            }
            let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401, attempt == 0, let fresh = await session.refreshedToken() {
                token = fresh
                continue
            }
            return (result.0, status)
        }
        throw APIError(status: 401, code: nil)
    }

    /// Downloads the attachment into the caches (one folder per id).
    static func download(_ attachment: MailAttachment, env: AppEnvironment) async throws -> URL {
        let url = env.serverURL
            .appendingPathComponent("api/mail-attachments")
            .appendingPathComponent(attachment.id)
            .appendingPathComponent("download")
        var request = URLRequest(url: url)
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 120
        let (data, status) = try await authorised(request, env: env)
        guard (200..<300).contains(status) else { throw APIError(status: status, code: nil) }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        let folder = caches
            .appendingPathComponent("mail-attachments", isDirectory: true)
            .appendingPathComponent(MailLogic.safeFileName(attachment.id), isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(MailLogic.safeFileName(attachment.fileName))
            try data.write(to: file, options: .atomic)
            return file
        } catch {
            throw APIError(status: 0, code: nil)
        }
    }

    /// Uploads one file; what the send references. Throws when it fails, so nothing is sent without it.
    static func upload(_ file: PickedFile, env: AppEnvironment) async throws -> UploadedAttachment {
        let bytes: Data
        do {
            bytes = try Data(contentsOf: file.url)
        } catch {
            throw APIError(status: 0, code: nil)
        }
        var generate = URLRequest(url: env.serverURL.appendingPathComponent("api/storage/generate-upload-url"))
        generate.httpMethod = "POST"
        generate.setValue("application/json", forHTTPHeaderField: "Content-Type")
        generate.setValue("application/json", forHTTPHeaderField: "Accept")
        generate.httpBody = try? JSONEncoder().encode(
            UploadRequest(fileName: file.name, contentType: file.mimeType, fileSize: bytes.count, folder: "mail-attachments")
        )
        let (answer, status) = try await authorised(generate, env: env)
        guard (200..<300).contains(status),
              let target = try? JSONDecoder().decode(UploadTarget.self, from: answer),
              let uploadURL = target.uploadUrl.flatMap(URL.init(string:)),
              let fileKey = target.fileKey
        else { throw APIError(status: status, code: nil) }

        // The URL's own one-time token authorises the write: the session's token never goes with it.
        var put = URLRequest(url: uploadURL)
        put.httpMethod = "PUT"
        put.timeoutInterval = 300
        put.setValue(file.mimeType, forHTTPHeaderField: "Content-Type")
        let response: URLResponse
        do {
            response = try await URLSession.shared.upload(for: put, from: bytes).1
        } catch {
            throw APIError(status: nil, code: nil)
        }
        let putStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(putStatus) else { throw APIError(status: putStatus, code: nil) }
        return UploadedAttachment(filename: file.name, contentType: file.mimeType, size: bytes.count, fileKey: fileKey)
    }

    /// A copy of a file the person picked (Files), in the temporary folder.
    static func copy(_ url: URL) -> PickedFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = MailLogic.safeFileName(url.lastPathComponent)
            let destination = folder.appendingPathComponent(name)
            try FileManager.default.copyItem(at: url, to: destination)
            let size = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            let type = UTType(filenameExtension: destination.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return PickedFile(name: name, url: destination, mimeType: type, size: size)
        } catch {
            return nil
        }
    }

    /// A photo (library or camera) written to a file.
    static func write(_ data: Data, type: UTType?, index: Int = 0) -> PickedFile? {
        let ext = type?.preferredFilenameExtension ?? "jpg"
        let stamp = Int64(Date().timeIntervalSince1970 * 1000)
        let name = index > 0 ? "photo_\(stamp)_\(index).\(ext)" : "photo_\(stamp).\(ext)"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            return nil
        }
        return PickedFile(name: name, url: url, mimeType: type?.preferredMIMEType ?? "image/jpeg", size: data.count)
    }
}
