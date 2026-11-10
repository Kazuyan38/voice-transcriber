// オフライン対応と、マルチスレッド WASM（SharedArrayBuffer）に必要な COOP/COEP ヘッダの付与。
// GitHub Pages ではレスポンスヘッダを設定できないため、Service Worker で同一オリジンの応答に付け直す。
const VERSION = "v1.0.0";
const APP = `app-${VERSION}`;
const VENDOR = "vendor-3.8.1";
const SHELL = [
  "./", "index.html", "config.js", "manifest.webmanifest",
  "js/app.js", "js/store.js", "js/cloud.js", "js/asr.js", "js/asr-worker.js", "js/recorder.js",
  "icons/icon.svg", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith("app-") && k !== APP) || (k.startsWith("vendor-") && k !== VENDOR)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!res || res.type === "opaque" || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Supabase・Hugging Face などの外部通信はそのまま通す（モデルは transformers.js が自前でキャッシュする）
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.includes("/vendor/")) {
    // 大きい WASM はインストール時に取らず、最初に使ったときにキャッシュする
    e.respondWith((async () => {
      const cache = await caches.open(VENDOR);
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    })());
    return;
  }

  // アプリ本体はネットワーク優先（更新をすぐ反映）、つながらなければキャッシュ
  e.respondWith((async () => {
    const cache = await caches.open(APP);
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res.ok) cache.put(req.mode === "navigate" ? "index.html" : req, res.clone());
      return isolate(res);
    } catch {
      const hit = await cache.match(req.mode === "navigate" ? "index.html" : req, { ignoreSearch: req.mode === "navigate" });
      return isolate(hit ?? new Response("オフラインです", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    }
  })());
});
