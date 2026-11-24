//
//  ViewController.swift
//  Shared (App)
//
//  Created by 王治凱 on 2026/11/25.
//

import WebKit

#if os(iOS)
import SwiftUI
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.chihkaiwang.nativeread.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView?

    override func viewDidLoad() {
        super.viewDidLoad()

#if os(iOS)
        self.webView?.removeFromSuperview()
        self.webView = nil
        let host = UIHostingController(rootView: NativeReadRootView())
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        host.didMove(toParent: self)
#elseif os(macOS)
        guard let webView = self.webView else { return }
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        if let htmlUrl = Bundle.main.url(forResource: "Main", withExtension: "html"),
           let resUrl = Bundle.main.resourceURL {
            webView.loadFileURL(htmlUrl, allowingReadAccessTo: resUrl)
        }
#endif
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        if (message.body as? String != "open-preferences") {
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else {
                return
            }

            DispatchQueue.main.async {
                NSApp.terminate(self)
            }
        }
#endif
    }

}
