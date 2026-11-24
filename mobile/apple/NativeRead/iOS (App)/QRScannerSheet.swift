//
//  QRScannerSheet.swift
//  iOS (App)
//
//  Built-in native camera QR scanner for zero-typing #nr_sync import.
//

#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit

struct QRScannerSheet: View {
    let onScanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permissionError: String? = nil

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let err = permissionError {
                    VStack(spacing: 16) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 52))
                            .foregroundStyle(.sky)
                        Text(err)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 24)
                        Button("關閉") { dismiss() }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    QRCapturePreview(
                        onCodeScanned: { value in
                            onScanned(value)
                            dismiss()
                        },
                        onUnavailable: { msg in
                            permissionError = msg
                        }
                    )
                    .ignoresSafeArea()

                    VStack {
                        Spacer()
                        Text("對準電腦端 NativeRead「📱 手機同步」QR Code")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(.bottom, 32)
                    }
                }
            }
            .navigationTitle("掃描設定 QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}

private extension ShapeStyle where Self == Color {
    static var sky: Color { Color(red: 0.22, green: 0.74, blue: 0.97) }
}

private struct QRCapturePreview: UIViewControllerRepresentable {
    let onCodeScanned: (String) -> Void
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> QRCaptureViewController {
        let vc = QRCaptureViewController()
        vc.onCodeScanned = onCodeScanned
        vc.onUnavailable = onUnavailable
        return vc
    }

    func updateUIViewController(_ uiViewController: QRCaptureViewController, context: Context) {}
}

final class QRCaptureViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCodeScanned: ((String) -> Void)?
    var onUnavailable: ((String) -> Void)?

    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .denied || status == .restricted {
            onUnavailable?("請於「設定 → NativeRead → 相機」允許權限後再掃描，或先使用「從剪貼簿匯入」。")
            return
        }
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.configureSession()
                    } else {
                        self.onUnavailable?("未取得相機權限，請改用「從剪貼簿匯入」。")
                    }
                }
            }
        } else {
            configureSession()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            onUnavailable?("此裝置目前無法開啟相機（例如模擬器），請直接使用「從剪貼簿匯入」。")
            return
        }

        let session = AVCaptureSession()
        guard session.canAddInput(input) else {
            onUnavailable?("無法初始化相機輸入，請改用「從剪貼簿匯入」。")
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onUnavailable?("無法初始化 QR Code 掃描輸出。")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)

        self.captureSession = session
        self.previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    private func stopSession() {
        guard let session = captureSession, session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            session.stopRunning()
        }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        let stringVal = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        guard let stringVal, !stringVal.isEmpty else { return }
        DispatchQueue.main.async {
            guard !self.didEmit else { return }
            self.didEmit = true
            self.stopSession()
            self.onCodeScanned?(stringVal)
        }
    }
}
#endif
