// Notifications for every signed-in account, worked out on the client.
//
// Xitter's public API has no notifications endpoint, so this builds them from
// what it does offer: replies and mentions (a search for "to:me OR @me"), new
// followers (the follower list, compared with the last look) and new likes and
// reposts (the counts on your recent posts, compared with the last look).
//
// A classic script so both the page and the service worker can load it; it
// defines self.XNotify. State lives in IndexedDB, shared by both.
(function () {
	"use strict";
	const DB = "xitter-notify";
	const MAX_ITEMS = 150;
	let dbp;
	function db() {
		if (!dbp)
			dbp = new Promise((resolve, reject) => {
				const req = indexedDB.open(DB, 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore("accounts");
					req.result.createObjectStore("state");
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		return dbp;
	}
	async function tx(store, mode, fn) {
		const d = await db();
		return new Promise((resolve, reject) => {
			const t = d.transaction(store, mode);
			const s = t.objectStore(store);
			let out;
			Promise.resolve(fn(s)).then((v) => (out = v));
			t.oncomplete = () => resolve(out);
			t.onerror = () => reject(t.error);
		});
	}
	const req = (r) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
	const getState = (key) => tx("state", "readonly", (s) => req(s.get(key))).then((v) => v || null);
	const putState = (key, v) => tx("state", "readwrite", (s) => s.put(v, key));

	const originOf = (instance) => `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(instance) ? "http" : "https"}://${instance}`;
	async function get(account, path, query) {
		const url = new URL(`${originOf(account.instance)}/api/v1${path}`);
		for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
		const res = await fetch(url, { headers: { authorization: `Bearer ${account.token}` }, cache: "no-store" });
		if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
		return (await res.json()).data;
	}

	function withLock(name, fn) {
		const locks = self.navigator && self.navigator.locks;
		return locks ? locks.request(name, { ifAvailable: true }, (lock) => (lock ? fn() : null)) : fn();
	}

	// one look at an account: what's new since the last one
	async function check(account) {
		return withLock(`xnotify:${account.key}`, async () => {
			const me = account.user.screen_name;
			const now = Date.now();
			const prev = (await getState(account.key)) || { items: [], followers: null, counts: null, lastSeen: 0, notified: now };
			const first = prev.followers === null;
			const items = prev.items.slice();
			const have = new Set(items.map((i) => i.id));
			const fresh = [];
			const add = (item) => {
				if (have.has(item.id)) return;
				have.add(item.id);
				items.push(item);
				fresh.push(item);
			};

			const [mentions, followers, mine] = await Promise.allSettled([
				get(account, "/search/posts", { q: `to:${me} OR @${me}`, limit: 40 }),
				get(account, `/users/${encodeURIComponent(me)}/followers`, { limit: 200 }),
				get(account, `/users/${encodeURIComponent(me)}/posts`, { limit: 40, replies: "true" }),
			]);
			if (mentions.status === "rejected" && mentions.reason.status === 401) throw mentions.reason;

			if (mentions.status === "fulfilled")
				for (const p of mentions.value) {
					if (p.author.screen_name.toLowerCase() === me.toLowerCase()) continue;
					add({ id: `m-${p.id}`, kind: p.reply_to ? "reply" : "mention", at: Date.parse(p.created_at) || now, post: p });
				}

			// Equicoins, where the instance has it and the account accepted its disclaimer:
			// money received, and requests asking it to pay
			let moneySeen = prev.moneySeen;
			try {
				const wallet = await get(account, "/money");
				if (wallet.disclaimer_accepted) {
					const [paid, asked] = await Promise.all([get(account, "/money/activity", { limit: 20 }), get(account, "/money/requests")]);
					const known = new Set(moneySeen || []);
					const baseline = moneySeen === undefined;
					for (const t of paid) {
						if (t.direction !== "received" || known.has(`p${t.id}`) || baseline) continue;
						add({ id: `$-${t.id}`, kind: "money", at: Date.parse(t.created_at) || now, payment: t });
					}
					for (const q of asked) {
						if (!q.can_pay || known.has(`r${q.id}`) || baseline) continue;
						add({ id: `$r-${q.id}`, kind: "money-request", at: Date.parse(q.created_at) || now, request: q });
					}
					moneySeen = [...new Set([...paid.map((t) => `p${t.id}`), ...asked.map((q) => `r${q.id}`), ...(moneySeen || [])])].slice(0, 500);
				}
			} catch {}

			let followerIds = prev.followers;
			if (followers.status === "fulfilled") {
				const known = new Set(prev.followers || []);
				const newcomers = first ? [] : followers.value.filter((u) => !known.has(u.id));
				if (newcomers.length) add({ id: `f-${now}`, kind: "follow", at: now, users: newcomers.slice(0, 20).map(slimUser), total: newcomers.length });
				followerIds = [...new Set([...followers.value.map((u) => u.id), ...(prev.followers || [])])].slice(0, 2000);
			}

			let counts = prev.counts;
			if (mine.status === "fulfilled") {
				counts = {};
				for (const p of mine.value) {
					if (p.reposted_by) continue;
					const c = [p.counts.likes, p.counts.reposts];
					counts[p.id] = c;
					const old = prev.counts && prev.counts[p.id];
					if (!old) continue;
					for (const [i, kind] of [[0, "like"], [1, "repost"]]) {
						const delta = c[i] - old[i];
						if (delta <= 0) continue;
						// fold into an unread group for the same post
						const open = items.find((x) => x.kind === kind && x.post.id === p.id && x.at > prev.lastSeen);
						if (open) {
							open.n += delta;
							open.at = now;
							open.post = p;
							if (!fresh.includes(open)) fresh.push(open);
						} else add({ id: `${kind[0]}-${p.id}-${now}`, kind, at: now, post: p, n: delta });
					}
				}
			}

			items.sort((a, b) => b.at - a.at);
			const state = {
				items: items.slice(0, MAX_ITEMS),
				followers: followerIds ?? [],
				counts: counts ?? {},
				lastSeen: first ? now : prev.lastSeen,
				moneySeen,
				notified: prev.notified,
				checkedAt: now,
			};
			// what hasn't been shown as a system notification yet
			const toNotify = first ? [] : fresh.filter((i) => i.at > prev.notified - 60_000 && !(prev.shown || []).includes(i.id + ":" + (i.n || 1)));
			state.notified = now;
			state.shown = [...toNotify.map((i) => i.id + ":" + (i.n || 1)), ...(prev.shown || [])].slice(0, 300);
			await putState(account.key, state);
			return { items: state.items, fresh: first ? [] : fresh, toNotify, unread: state.items.filter((i) => i.at > state.lastSeen).length };
		});
	}

	const slimUser = (u) => ({ id: u.id, screen_name: u.screen_name, name: u.name, avatar_url: u.avatar_url, verified_type: u.verified_type });

	const cents = (n) => `$${Math.floor(n / 100).toLocaleString("en-US")}${n % 100 ? "." + String(n % 100).padStart(2, "0") : ""}`;
	function describe(item) {
		const who = (u) => u.name || "@" + u.screen_name;
		const snippet = (p) => (p.text || (p.media && p.media.length ? "your media" : "")).slice(0, 120);
		switch (item.kind) {
			case "reply": return { title: `${who(item.post.author)} replied`, body: item.post.text };
			case "mention": return { title: `${who(item.post.author)} mentioned you`, body: item.post.text };
			case "follow": return { title: item.total > 1 ? `${who(item.users[0])} and ${item.total - 1} other${item.total > 2 ? "s" : ""} followed you` : `${who(item.users[0])} followed you`, body: "" };
			case "like": return { title: `${item.n} new like${item.n > 1 ? "s" : ""} on your post`, body: snippet(item.post) };
			case "repost": return { title: `${item.n} new repost${item.n > 1 ? "s" : ""} of your post`, body: snippet(item.post) };
			case "money": return { title: `${who(item.payment.sender)} sent you ${cents(item.payment.amount_cents)}`, body: item.payment.note || "" };
			case "money-request": return { title: `${who(item.request.requester)} asked you for ${cents(item.request.amount_cents)}`, body: item.request.note || "" };
		}
		return { title: "Xitter", body: "" };
	}

	async function show(account, items, multi) {
		const reg = self.registration || (self.navigator.serviceWorker && (await self.navigator.serviceWorker.ready));
		if (!reg || typeof Notification === "undefined" || Notification.permission !== "granted") return;
		for (const item of items.slice(0, 4)) {
			const d = describe(item);
			const face = item.post ? item.post.author : item.payment ? item.payment.sender : item.request ? item.request.requester : item.users && item.users[0];
			const icon = face && face.avatar_url;
			await reg.showNotification(multi ? `${d.title} · @${account.user.screen_name}` : d.title, {
				body: d.body,
				icon: icon || "icons/icon-192.png",
				badge: "icons/badge-96.png",
				tag: `${account.key}:${item.id}`,
				timestamp: item.at,
				data: { key: account.key, item: item.id, post: item.post ? item.post.id : null, money: item.kind.startsWith("money") },
			});
		}
		if (items.length > 4) {
			await reg.showNotification(`${items.length - 4} more for @${account.user.screen_name}`, { tag: `${account.key}:more`, badge: "icons/badge-96.png", icon: "icons/icon-192.png", data: { key: account.key } });
		}
	}

	async function totalUnread() {
		const list = await loadAccounts();
		let n = 0;
		for (const a of list) {
			const s = await getState(a.key);
			if (s) n += s.items.filter((i) => i.at > s.lastSeen).length;
		}
		return n;
	}
	async function setBadge() {
		try {
			const n = await totalUnread();
			const nav = self.navigator;
			if (n) await nav.setAppBadge?.(n);
			else await nav.clearAppBadge?.();
		} catch {}
	}

	async function loadAccounts() {
		return (await tx("accounts", "readonly", (s) => req(s.get("list")))) || [];
	}

	self.XNotify = {
		check,
		describe,
		show,
		setBadge,
		getState,
		loadAccounts,
		saveAccounts: (list) =>
			tx("accounts", "readwrite", (s) => s.put(list.map((a) => ({ key: a.key, instance: a.instance, token: a.token, user: { screen_name: a.user.screen_name, name: a.user.name, avatar_url: a.user.avatar_url } })), "list")).catch(() => {}),
		forget: (key) => tx("state", "readwrite", (s) => s.delete(key)).catch(() => {}),
		async markSeen(key) {
			const s = await getState(key);
			if (!s) return;
			s.lastSeen = Date.now();
			await putState(key, s);
			setBadge();
		},
		// every account, showing system notifications for what's new (the worker's periodic sync)
		async checkAll() {
			const list = await loadAccounts();
			for (const a of list) {
				try {
					const r = await check(a);
					if (r && r.toNotify.length) await show(a, r.toNotify, list.length > 1);
				} catch {}
			}
			await setBadge();
		},
	};
})();
