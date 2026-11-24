//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Native messaging bridge between the containing iOS/macOS App (NativeReadStore)
//  and the Safari Web Extension background service worker.
//

import Foundation
import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let dict = message as? [String: Any]
        let msgType = (dict?["type"] as? String) ?? ""
        os_log(.default, "NativeRead Safari extension native message type: %{public}@", msgType)

        var replyPayload: [String: Any] = ["ok": true]
        if msgType == "GET_SYNC_SETTINGS" {
            let rawJson = NativeReadStore.loadRawJson() ?? ""
            replyPayload = [
                "ok": !rawJson.isEmpty,
                "settingsJson": rawJson
            ]
        } else if msgType == "SAVE_SYNC_SETTINGS" {
            let incomingJson = (dict?["settingsJson"] as? String) ?? ""
            let saved = !incomingJson.isEmpty && NativeReadStore.saveValidatedRawJsonIfNewer(incomingJson)
            replyPayload = ["ok": saved]
        } else {
            replyPayload = ["ok": true, "echo": msgType]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: replyPayload]
        } else {
            response.userInfo = ["message": replyPayload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
