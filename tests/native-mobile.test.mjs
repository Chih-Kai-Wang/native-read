import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('Apple iOS & macOS Xcode project exposes NativeRead Store, Safari Extension bridge, and 1-tap browser', () => {
  const appleRoot = path.join(REPO_ROOT, 'mobile', 'apple', 'NativeRead');
  const pbxPath = path.join(appleRoot, 'NativeRead.xcodeproj', 'project.xcproj');
  assert.equal(fs.existsSync(pbxPath), true, 'Xcode project.xcproj must exist');
  const xcproj = fs.readFileSync(pbxPath, 'utf8');
  for (const requiredRef of [
    'NativeReadStore.swift',
    'SafariWebExtensionHandler.swift',
    'NativeReadAppView.swift',
    'QRScannerSheet.swift',
    'nativeread.user.js'
  ]) {
    assert.ok(xcproj.includes(requiredRef), `project.xcproj must include ${requiredRef}`);
  }

  const handlerSwift = fs.readFileSync(
    path.join(appleRoot, 'Shared (Extension)', 'SafariWebExtensionHandler.swift'),
    'utf8'
  );
  assert.ok(handlerSwift.includes('GET_SYNC_SETTINGS'), 'SafariWebExtensionHandler must answer GET_SYNC_SETTINGS');
  assert.ok(handlerSwift.includes('NativeReadStore.loadRawJson'), 'SafariWebExtensionHandler must read NativeReadStore');

  const storeSwift = fs.readFileSync(
    path.join(appleRoot, 'Shared (Extension)', 'NativeReadStore.swift'),
    'utf8'
  );
  assert.ok(storeSwift.includes('group.com.chihkaiwang.nativeread'), 'NativeReadStore must use shared App Group');
  assert.ok(storeSwift.includes('nr_sync='), 'NativeReadStore must parse #nr_sync tokens');

  const iosPlist = fs.readFileSync(path.join(appleRoot, 'iOS (App)', 'Info.plist'), 'utf8');
  assert.ok(iosPlist.includes('NSCameraUsageDescription'), 'iOS Info.plist must declare camera permission for QR scanner');
  assert.ok(iosPlist.includes('<string>nativeread</string>'), 'iOS Info.plist must register nativeread:// scheme');

  const appViewSwift = fs.readFileSync(path.join(appleRoot, 'iOS (App)', 'NativeReadAppView.swift'), 'utf8');
  assert.ok(appViewSwift.includes('WKContentWorld.defaultClient'), 'iOS WKWebView must isolate NativeRead in defaultClient world');

  const extManifest = JSON.parse(
    fs.readFileSync(path.join(appleRoot, 'Shared (Extension)', 'Resources', 'manifest.json'), 'utf8')
  );
  assert.equal('minimum_chrome_version' in extManifest, false, 'Safari extension manifest must strip minimum_chrome_version');
});

test('Android native Compose project declares Share/DeepLink intents, nonce bridge, and synced offline assets', () => {
  const androidRoot = path.join(REPO_ROOT, 'mobile', 'android');
  const manifestXml = fs.readFileSync(
    path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8'
  );
  assert.ok(manifestXml.includes('android.intent.action.SEND'), 'AndroidManifest must accept Share Sheet ACTION_SEND');
  assert.ok(manifestXml.includes('android:scheme="nativeread"'), 'AndroidManifest must register nativeread:// deep links');
  assert.ok(manifestXml.includes('android.permission.INTERNET'), 'AndroidManifest must request INTERNET permission');

  const ktDir = path.join(androidRoot, 'app', 'src', 'main', 'kotlin', 'com', 'chihkaiwang', 'nativeread');
  const syncStoreKt = fs.readFileSync(path.join(ktDir, 'SyncStore.kt'), 'utf8');
  const bridgeKt = fs.readFileSync(path.join(ktDir, 'NativeReadBridge.kt'), 'utf8');
  const mainActivityKt = fs.readFileSync(path.join(ktDir, 'MainActivity.kt'), 'utf8');

  assert.ok(syncStoreKt.includes('nr_sync='), 'SyncStore.kt must decode #nr_sync tokens');
  assert.ok(bridgeKt.includes('@JavascriptInterface'), 'NativeReadBridge.kt must expose JS bridge methods');
  assert.ok(bridgeKt.includes('currentNonce'), 'NativeReadBridge.kt must gate bridge calls with per-page nonce');
  assert.ok(mainActivityKt.includes('WebViewAssetLoader'), 'MainActivity.kt must serve bundled offline PDF PWA via WebViewAssetLoader');
  assert.ok(mainActivityKt.includes('NRAndroidBridge'), 'MainActivity.kt must attach NRAndroidBridge to WebView');

  assert.equal(
    fs.existsSync(path.join(androidRoot, 'app', 'src', 'main', 'assets', 'nativeread.user.js')),
    true,
    'Android assets must contain synced nativeread.user.js'
  );
  assert.equal(
    fs.existsSync(path.join(androidRoot, 'app', 'src', 'main', 'assets', 'pwa', 'index.html')),
    true,
    'Android assets/pwa must contain bundled PDF reader PWA'
  );

  // Secret hygiene across native Swift & Kotlin files
  for (const text of [syncStoreKt, bridgeKt, mainActivityKt]) {
    assert.equal(/AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z]{16,}/.test(text), false, 'Native code must contain zero hardcoded API keys');
  }
});
