// A client for one account's instance: Xitter's public JSON API under /api/v1
// (Bearer token, CORS open to any origin), plus the OAuth token exchange.

export const originOf = (instance) =>
	`${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(instance) ? "http" : "https"}://${instance}`;

export class ApiError extends Error {
	constructor(status, message, retryAfter) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

// Posts are shared between screens: a like on the detail page updates the same
// post in the timeline. Listeners get every fresh copy of a post.
const bus = new EventTarget();
export const onPostUpdate = (fn) => {
	const h = (e) => fn(e.detail);
	bus.addEventListener("post", h);
	return () => bus.removeEventListener("post", h);
};
export const onPostDelete = (fn) => {
	const h = (e) => fn(e.detail);
	bus.addEventListener("delete", h);
	return () => bus.removeEventListener("delete", h);
};
export const onAuthFailure = (fn) => bus.addEventListener("auth", (e) => fn(e.detail));

const clients = new Map();
export function apiFor(account) {
	let c = clients.get(account.key);
	if (!c || c.token !== account.token) {
		c = new Api(account);
		clients.set(account.key, c);
	}
	return c;
}

export class Api {
	constructor(account) {
		this.key = account.key;
		this.instance = account.instance;
		this.token = account.token;
		this.origin = originOf(account.instance);
		this.base = `${this.origin}/api/v1`;
		this.posts = new Map(); // id -> post
		this.users = new Map(); // screen_name (lowercase) -> user
		this.inflight = new Map();
	}

	async request(method, path, { query, body, headers = {}, signal, timeout = 20000 } = {}) {
		const url = new URL(this.base + path);
		if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeout);
		signal?.addEventListener("abort", () => ctl.abort());
		const init = { method, headers: { authorization: `Bearer ${this.token}`, ...headers }, signal: ctl.signal, cache: "no-store" };
		if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
		else if (body !== undefined) {
			init.body = JSON.stringify(body);
			init.headers["content-type"] = "application/json";
		}
		let res;
		try {
			res = await fetch(url, init);
		} catch (e) {
			throw new ApiError(0, ctl.signal.aborted && !signal?.aborted ? "The instance took too long to answer." : navigator.onLine === false ? "You're offline." : `Couldn't reach ${this.instance}.`);
		} finally {
			clearTimeout(timer);
		}
		const out = await res.json().catch(() => ({}));
		if (!res.ok) {
			if (res.status === 401) bus.dispatchEvent(new CustomEvent("auth", { detail: this.key }));
			const retry = Number(res.headers.get("retry-after")) || undefined;
			throw new ApiError(res.status, out?.error || (res.status === 429 ? `Slow down — try again in ${retry ?? 60}s.` : `Something went wrong (${res.status}).`), retry);
		}
		return out;
	}

	// GETs for the same URL share one request
	get(path, query, opts) {
		const id = path + "?" + new URLSearchParams(query ?? {}).toString();
		if (this.inflight.has(id)) return this.inflight.get(id);
		const p = this.request("GET", path, { query, ...opts }).finally(() => this.inflight.delete(id));
		this.inflight.set(id, p);
		return p;
	}

	remember(post) {
		if (!post) return post;
		this.posts.set(post.id, post);
		if (post.author) this.users.set(post.author.screen_name.toLowerCase(), { ...this.users.get(post.author.screen_name.toLowerCase()), ...post.author });
		return post;
	}
	publish(post) {
		this.remember(post);
		bus.dispatchEvent(new CustomEvent("post", { detail: { key: this.key, post } }));
		return post;
	}
	rememberPage(out) {
		for (const p of out.data ?? []) this.remember(p);
		return out;
	}

	me() {
		return this.get("/me").then((r) => r.data);
	}
	async user(name) {
		const r = await this.get(`/users/${encodeURIComponent(name)}`);
		this.users.set(r.data.screen_name.toLowerCase(), r.data);
		return r.data;
	}
	cachedUser(name) {
		return this.users.get(String(name).toLowerCase());
	}
	// replies: false for posts, true to mix replies in, "only" for a Replies tab. An
	// instance that predates replies=only answers with its posts too; those are dropped here
	userPosts(name, { cursor, replies, limit = 25 } = {}) {
		return this.get(`/users/${encodeURIComponent(name)}/posts`, { cursor, limit, replies: replies === "only" ? "only" : replies ? "true" : undefined })
			.then((r) => this.rememberPage(r))
			.then((r) => (replies === "only" ? { ...r, data: (r.data || []).filter((p) => p.reply_to) } : r));
	}
	// PATCH /me (Xitter from today): name, bio, location, website, avatar_media_id, banner_media_id, remove_banner
	updateProfile(fields) {
		return this.request("PATCH", "/me", { body: fields }).then((r) => r.data);
	}
	likers(id, limit = 100) {
		return this.get(`/posts/${id}/likes`, { limit }).then((r) => r.data);
	}
	follows(name, which, limit = 100) {
		return this.get(`/users/${encodeURIComponent(name)}/${which}`, { limit }).then((r) => r.data);
	}
	timeline({ cursor, limit = 30 } = {}) {
		return this.get("/timeline", { cursor, limit }).then((r) => this.rememberPage(r));
	}
	async post(id, { fresh } = {}) {
		if (!fresh && this.posts.has(id)) return this.posts.get(id);
		const r = await this.get(`/posts/${id}`);
		return this.remember(r.data);
	}
	replies(id, limit = 60) {
		return this.get(`/posts/${id}/replies`, { limit }).then((r) => this.rememberPage(r).data);
	}
	searchPosts(q, { sort, cursor, limit = 25 } = {}) {
		return this.get("/search/posts", { q, sort, cursor, limit }).then((r) => this.rememberPage(r));
	}
	searchUsers(q, limit = 20) {
		return this.get("/search/users", { q, limit }).then((r) => r.data);
	}

	async createPost(body) {
		const r = await this.request("POST", "/posts", { body });
		return this.publish(r.data);
	}
	async deletePost(id) {
		await this.request("DELETE", `/posts/${id}`);
		this.posts.delete(id);
		bus.dispatchEvent(new CustomEvent("delete", { detail: { key: this.key, id } }));
	}
	// like / repost / bookmark, on or off; answers with the post as it is now
	async toggle(id, what, on) {
		const r = await this.request(on ? "POST" : "DELETE", `/posts/${id}/${what}`);
		return this.publish(r.data);
	}
	async follow(name, on) {
		const r = await this.request(on ? "POST" : "DELETE", `/users/${encodeURIComponent(name)}/follow`);
		this.users.set(r.data.screen_name.toLowerCase(), r.data);
		return r.data;
	}

	// ---- Equicoins: the instance's own play money (404 when it's off or unsupported)
	money() {
		return this.request("GET", "/money").then((r) => r.data);
	}
	acceptMoneyDisclaimer() {
		return this.request("POST", "/money/disclaimer");
	}
	moneyActivity(cursor) {
		return this.request("GET", "/money/activity", { query: { cursor, limit: 30 } });
	}
	moneyRequests() {
		return this.request("GET", "/money/requests").then((r) => r.data);
	}
	// to, amount_cents, note, idempotency_key, request_id
	sendMoney(body) {
		return this.request("POST", "/money/send", { body }).then((r) => r.data);
	}
	// from (omit for a "Pay @you" card), amount_cents, note
	requestMoney(body) {
		return this.request("POST", "/money/requests", { body }).then((r) => r.data);
	}
	closeMoneyRequest(id, action) {
		return this.request("POST", `/money/requests/${id}/${action}`).then((r) => r.data);
	}
	payment(id) {
		return this.get(`/money/payments/${id}`).then((r) => r.data);
	}
	moneyRequest(id, { fresh } = {}) {
		return (fresh ? this.request("GET", `/money/requests/${id}`) : this.get(`/money/requests/${id}`)).then((r) => r.data);
	}

	// Upload a file and wait until it can be attached. Small files go up in one
	// request; larger ones in 4 MiB segments, with progress.
	async upload(file, onProgress = () => {}) {
		const type = file.type || "application/octet-stream";
		let id;
		if (file.size <= 4 * 1024 * 1024 && !type.startsWith("video/")) {
			onProgress(0.1);
			const r = await this.request("POST", "/media", { body: file, headers: { "content-type": type }, timeout: 120000 });
			id = r.data.media_id;
			onProgress(1);
			if (r.data.processing === "succeeded") return id;
		} else {
			const start = await this.request("POST", "/media/uploads", { body: { media_type: type, total_bytes: file.size } });
			id = start.data.media_id;
			const size = Math.min(start.data.max_segment_bytes || 5 * 1024 * 1024, 4 * 1024 * 1024);
			const n = Math.ceil(file.size / size);
			for (let i = 0; i < n; i++) {
				const chunk = file.slice(i * size, (i + 1) * size);
				for (let attempt = 0; ; attempt++) {
					try {
						await this.request("POST", `/media/${id}/segments/${i}`, { body: chunk, headers: { "content-type": "application/octet-stream" }, timeout: 120000 });
						break;
					} catch (e) {
						if (attempt >= 2 || (e.status && e.status < 500 && e.status !== 429)) throw e;
						await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
					}
				}
				onProgress(((i + 1) / n) * 0.9);
			}
			const done = await this.request("POST", `/media/${id}/finalize`);
			if (done.data.processing === "succeeded") return onProgress(1), id;
			if (done.data.processing === "failed") throw new ApiError(400, done.data.error || "That file couldn't be processed.");
		}
		// wait for processing (videos)
		for (let i = 0; i < 120; i++) {
			const s = await this.request("GET", `/media/${id}`);
			if (s.data.processing === "succeeded") return onProgress(1), id;
			if (s.data.processing === "failed") throw new ApiError(400, s.data.error || "That file couldn't be processed.");
			if (s.data.progress_percent) onProgress(0.9 + s.data.progress_percent / 1000);
			await new Promise((r) => setTimeout(r, Math.max(1, s.data.check_after_secs ?? 2) * 1000));
		}
		throw new ApiError(408, "Processing took too long.");
	}
}

// Verify a token and learn who it belongs to, before saving an account.
export async function whoAmI(instance, token) {
	const res = await fetch(`${originOf(instance)}/api/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
	if (!res) throw new ApiError(0, `Couldn't reach ${instance}. Check the address, or that it's a Xitter instance.`);
	const out = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "That token wasn't accepted. Make a new one and paste it in full." : out.error || `The instance answered ${res.status}.`);
	return out.data;
}
