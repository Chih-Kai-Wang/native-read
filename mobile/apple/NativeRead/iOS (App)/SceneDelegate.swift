//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by 王治凱 on 2026/11/25.
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        if let url = connectionOptions.urlContexts.first?.url {
            NativeReadAppModel.shared.handleIncomingURL(url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            NativeReadAppModel.shared.handleIncomingURL(context.url)
        }
    }

}
