import CoreLocation
import Foundation

/// Where the phone is, for clocking in or out where the workspace requires
/// being at a work location: one fix at the moment of the tap, never
/// tracking, with "when in use" permission only.
@MainActor
final class ClockLocator: NSObject, CLLocationManagerDelegate {
    enum Outcome: Equatable {
        case found(HRGeoFix)
        /// Permission refused: the person has to allow it in Settings.
        case denied
        /// Permission is fine but there is no position (location services off, no signal).
        case unavailable
    }

    /// How long to wait for a fresh fix before settling for the last known one.
    static let fixTimeout: TimeInterval = 10
    /// A last known fix older than this is no use for "are you at work right now".
    static let lastKnownMaxAge: TimeInterval = 120

    private let manager = CLLocationManager()
    private var authorization: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var fix: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    /// A fix for the clock call, asking for permission first when iOS still will.
    func locate() async -> Outcome {
        var status = manager.authorizationStatus
        if status == .notDetermined {
            status = await withCheckedContinuation { continuation in
                authorization = continuation
                manager.requestWhenInUseAuthorization()
            }
        }
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return .denied }
        let fresh = await currentLocation()
        let recent = manager.location.flatMap { -$0.timestamp.timeIntervalSinceNow <= Self.lastKnownMaxAge ? $0 : nil }
        guard let location = fresh ?? recent,
              let fix = Self.toFix(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude, accuracy: location.horizontalAccuracy)
        else { return .unavailable }
        return .found(fix)
    }

    /// What the clock call sends: the accuracy rounded to whole metres, left out when unknown.
    nonisolated static func toFix(latitude: Double, longitude: Double, accuracy: Double?) -> HRGeoFix? {
        guard latitude.isFinite, longitude.isFinite else { return nil }
        let metres = accuracy.flatMap { $0.isFinite && $0 >= 0 ? $0.rounded() : nil }
        return HRGeoFix(latitude: latitude, longitude: longitude, accuracy: metres)
    }

    private func currentLocation() async -> CLLocation? {
        await withCheckedContinuation { continuation in
            fix = continuation
            manager.requestLocation()
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.fixTimeout))
                self?.finish(nil)
            }
        }
    }

    private func finish(_ location: CLLocation?) {
        guard let continuation = fix else { return }
        fix = nil
        continuation.resume(returning: location)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard status != .notDetermined, let continuation = self.authorization else { return }
            self.authorization = nil
            continuation.resume(returning: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.finish(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
