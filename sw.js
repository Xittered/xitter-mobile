// Service worker: the app shell offline, a bounded cache for avatars and
// media, and notification checks in the background where the browser allows
// (Periodic Background Sync, on installed Chromium apps).
const VERSION = "v1.10.1";
const SHELL = `shell-${VERSION}`;
const MEDIA = "media-v1";
const MEDIA_MAX = 400;

const FILES = [
	"./",
	"config.js",
	"manifest.webmanifest",
	"css/app.css",
	"js/app.js",
	"js/api.js",
	"js/store.js",
	"js/util.js",
	"js/nav.js",
	"js/post.js",
	"js/pages.js",
	"js/compose.js",
	"js/auth.js",
	"js/notifications.js",
	"js/notify-core.js",
	"js/media.js",
	"js/money.js",
	"icons/icon-192.png",
	"icons/badge-96.png",
];

importScripts("js/notify-core.js");

// Hosts that tidy URLs (Cloudflare Pages, GitHub Pages) answer some paths with a
// redirect. Safari refuses to show a page from a service worker response that
// was redirected, so every cached copy is stored as a fresh, unredirected one.
async function clean(res) {
	if (!res.redirected) return res;
	return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}
async function store(c, key, res) {
	if (res.ok) await c.put(key, await clean(res));
}

self.addEventListener("install", (e) => {
	e.waitUntil(
		(async () => {
			const c = await caches.open(SHELL);
			await Promise.all(FILES.map(async (f) => store(c, f, await fetch(new Request(f, { cache: "reload" })))));
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		(async () => {
			for (const k of await caches.keys()) if (k.startsWith("shell-") && k !== SHELL) await caches.delete(k);
			await self.clients.claim();
		})(),
	);
});

const isMedia = (url, req) => req.destination === "image" || /\/(media|avatars?|banners?|profile_images)\//.test(url.pathname) || /\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname);

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	// never touch API calls or sign-in
	if (url.pathname.includes("/api/v1") || url.pathname.startsWith("/oauth")) return;

	if (url.origin === location.origin) {
		// app shell: cached first, refreshed behind the scenes
		// every page of the app is the same shell, cached under "./"
		if (req.mode === "navigate") {
			const net = fetch("./", { cache: "no-cache" }).then(clean);
			e.waitUntil(net.then(async (res) => store(await caches.open(SHELL), "./", res.clone())).catch(() => {}));
			// never leave the browser with an error page: cache, then network, then the real request
			e.respondWith(caches.match("./").then((hit) => (hit ? clean(hit) : net)).catch(() => fetch(req)));
			return;
		}
		e.respondWith(
			caches.match(req, { ignoreSearch: true }).then((hit) => {
				const net = fetch(req).then(clean).then((res) => {
					if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
					return res;
				}).catch(() => hit);
				return hit || net;
			}),
		);
		return;
	}

	if (isMedia(url, req) && req.destination !== "video") {
		e.respondWith(
			caches.open(MEDIA).then(async (c) => {
				const hit = await c.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok || res.type === "opaque") {
					c.put(req, res.clone()).then(() => trim(c));
				}
				return res;
			}),
		);
	}
});

let trimming = false;
async function trim(c) {
	if (trimming) return;
	trimming = true;
	try {
		const keys = await c.keys();
		for (let i = 0; i < keys.length - MEDIA_MAX; i++) await c.delete(keys[i]);
	} finally {
		trimming = false;
	}
}

self.addEventListener("periodicsync", (e) => {
	if (e.tag === "xit-notify") e.waitUntil(self.XNotify.checkAll());
});

self.addEventListener("message", (e) => {
	if (e.data?.type === "check-all") e.waitUntil(self.XNotify.checkAll());
	if (e.data?.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const data = e.notification.data || {};
	e.waitUntil(
		(async () => {
			const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const msg = { type: "open-notification", key: data.key, post: data.post, money: !!data.money };
			const client = all[0];
			if (client) {
				await client.focus();
				client.postMessage(msg);
			} else {
				await self.clients.openWindow(`./#open=${encodeURIComponent(JSON.stringify(msg))}`);
			}
		})(),
	);
});
