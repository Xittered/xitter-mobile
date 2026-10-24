// The app: one root per signed-in account (each with its own tab stacks, kept
// alive so switching back is instant), the tab bar, the drawer and the account
// switcher. Switching accounts is switching instances: every account carries
// its own instance and token.

import { apiFor, onAuthFailure } from "./api.js";
import { addAccountFlow, finishOAuth, reauthorize, welcomeScreen } from "./auth.js";
import { compose } from "./compose.js";
import { viewMedia } from "./media.js";
import { Stack, banner, pushBack, dropBack, sheet, toast } from "./nav.js";
import { MoneyPage, moneyKnown } from "./money.js";
import { NotificationCenter, NotificationsPage } from "./notifications.js";
import { watchPosts } from "./post.js";
import { EditProfilePage, FollowsPage, HomePage, LikersPage, PostPage, ProfilePage, SearchPage, SearchResultsPage, SettingsPage } from "./pages.js";
import * as store from "./store.js";
import { $, $$, avatar, el, esc, haptic, icon, pressable } from "./util.js";

const TABS = ["home", "search", "notifications", "profile"];
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

class AccountRoot {
	constructor(app, account) {
		this.app = app;
		this.account = account;
		this.api = apiFor(account);
		this.el = el(`<div class="acct-root" data-key="${esc(account.key)}">${TABS.map((t) => `<div class="stack" data-tab="${t}" hidden></div>`).join("")}</div>`);
		this.stacks = {};
		this.tab = null;
		this.unwatch = watchPosts(this.el, this.api);
		for (const t of TABS) {
			const make = () => {
				const ctx = this.ctx({ isTabRoot: true });
				if (t === "home") return new HomePage(ctx);
				if (t === "search") return new SearchPage(ctx);
				if (t === "notifications") return new NotificationsPage(ctx);
				return new ProfilePage(ctx, { name: account.user.screen_name, user: account.user });
			};
			const s = new Stack(this.el.querySelector(`[data-tab="${t}"]`), make);
			s.onChange = () => this.app.updateChrome();
			this.stacks[t] = s;
		}
	}
	get stack() {
		return this.stacks[this.tab];
	}
	ctx(extra = {}) {
		const self = this;
		return {
			app: this.app,
			api: this.api,
			account: this.account,
			root: this.el,
			chrome: this.app.el,
			...extra,
			open: (type, params = {}) => self.open(type, params),
			back: () => self.stack.pop(),
			compose: (opts) => self.compose(opts),
			drawer: () => self.app.openDrawer(),
			viewMedia: (post, i) => viewMedia(self.ctx(), post, i),
			viewImage: (url) => url && viewMedia(self.ctx(), null, 0, { images: [url] }),
		};
	}
	open(type, params) {
		const ctx = this.ctx();
		let page;
		if (type === "post") page = new PostPage(ctx, params);
		else if (type === "profile") page = new ProfilePage(ctx, params);
		else if (type === "search") page = new SearchResultsPage(ctx, params);
		else if (type === "explore") {
			// Explore was the same Latest and Popular feeds the home tabs have, so it's
			// the home Latest tab now
			this.selectTab("home");
			const home = this.stacks.home;
			if (home.pages.length > 1) home.popToRoot();
			home.pages[0]?.select("latest", { animate: true });
			this.app.updateChrome();
			return;
		}
		else if (type === "money") page = new MoneyPage(ctx);
		else if (type === "follows") page = new FollowsPage(ctx, params);
		else if (type === "likers") page = new LikersPage(ctx, params);
		else if (type === "editProfile") page = new EditProfilePage(ctx, params);
		else if (type === "settings") page = new SettingsPage(ctx);
		if (!page) return;
		this.app.el.classList.remove("bar-hidden");
		this.stack.push(page);
		this.app.updateChrome();
	}
	compose(opts = {}) {
		compose({ ...this.ctx(), posted: (post, { replyTo }) => this.posted(post, replyTo) }, opts);
	}
	posted(post, replyTo) {
		const feed = this.stacks.home.pages[0]?.feeds?.following;
		if (!replyTo && feed) {
			feed.append([post], { prepend: true });
			feed.list.querySelector(".post")?.classList.add("arrive");
		}
		// a reply lands under its post if that page is open
		for (const s of Object.values(this.stacks))
			for (const p of s.pages)
				if (replyTo && p instanceof PostPage && p.id === replyTo.id) p.load(false);
	}
	selectTab(tab) {
		const prev = this.tab;
		if (prev === tab) {
			// tapping the current tab: back to its root, or up to the top
			const s = this.stack;
			if (s.pages.length > 1) s.popToRoot();
			else s.top?.scrollTop();
			return;
		}
		this.tab = tab;
		for (const t of TABS) this.el.querySelector(`[data-tab="${t}"]`).hidden = t !== tab;
		if (prev) this.stacks[prev].top?.hide();
		const s = this.stacks[tab];
		const fresh = !s.pages.length;
		s.ensureRoot();
		if (!fresh) s.top?.show();
		this.app.el.classList.remove("bar-hidden");
	}
	destroy() {
		this.unwatch();
		for (const s of Object.values(this.stacks)) for (const p of s.pages) p.destroy();
		this.el.remove();
	}
}

class App {
	constructor() {
		this.el = document.getElementById("app");
		this.roots = new Map();
		this.active = null;
		this.notifications = new NotificationCenter(this);
		this.accountListeners = new Set();
		store.onAccountsChange(() => {
			for (const fn of this.accountListeners) fn();
		});
		onAuthFailure((key) => this.authFailed(key));
	}
	accounts() {
		return store.accounts();
	}
	onAccounts(fn) {
		this.accountListeners.add(fn);
		return () => this.accountListeners.delete(fn);
	}

	async start() {
		store.applyTheme();
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", store.applyTheme);
		pressable(document.body);
		this.registerWorker();
		try {
			const acct = await finishOAuth();
			if (acct) toast(`Signed in as @${acct.user.screen_name}`);
		} catch (e) {
			toast(e.message, { error: true });
		}
		self.XNotify?.saveAccounts(store.accounts());
		document.getElementById("boot")?.remove();
		if (!store.accounts().length) return this.welcome();
		this.buildChrome();
		this.switchTo(store.activeAccount().key, { quiet: true });
		this.notifications.start();
		this.handleHash();
		addEventListener("hashchange", () => this.handleHash());
		navigator.serviceWorker?.addEventListener("message", (e) => {
			if (e.data?.type === "open-notification") this.openNotification(e.data.key, e.data.post, { money: e.data.money });
		});
		// refresh profile details for every account now and then
		setTimeout(() => this.refreshProfiles(), 3000);
	}

	welcome() {
		this.el.innerHTML = "";
		const w = welcomeScreen((acct) => {
			store.setActive(acct.key);
			location.reload();
		});
		this.el.append(w);
	}

	buildChrome() {
		this.el.innerHTML = `<div class="roots"></div>
			<nav class="tabbar">${TABS.map((t) => `<button class="tab press" data-tab="${t}" aria-label="${t}">${t === "profile" ? `<span class="tab-av"></span>` : `${icon(t === "home" ? "home" : t === "search" ? "search" : "bell", "off")}${icon(t === "home" ? "home-f" : t === "search" ? "search-f" : "bell-f", "on")}`}${t === "notifications" ? `<span class="tab-badge" hidden></span>` : ""}${t === "profile" ? `<span class="badge-dot" hidden></span>` : ""}</button>`).join("")}</nav>
			<button class="fab press" aria-label="New post">${icon("plus")}</button>`;
		this.rootsEl = $(".roots", this.el);
		const tabbar = $(".tabbar", this.el);
		tabbar.addEventListener("click", (e) => {
			const b = e.target.closest("[data-tab]");
			if (!b || this.suppressClick) return;
			haptic(4);
			this.current.selectTab(b.dataset.tab);
			this.updateChrome();
		});
		$(".fab", this.el).onclick = () => {
			haptic(8);
			this.current.compose();
		};
		// long-press an avatar (tab bar or top-left) for the account switcher
		let timer = null;
		this.el.addEventListener("pointerdown", (e) => {
			const t = e.target.closest('.tab[data-tab="profile"], [data-drawer]');
			if (!t) return;
			this.suppressClick = false;
			timer = setTimeout(() => {
				this.suppressClick = true;
				haptic(15);
				this.openSwitcher();
			}, 420);
		});
		const cancel = () => clearTimeout(timer);
		this.el.addEventListener("pointerup", cancel);
		this.el.addEventListener("pointercancel", cancel);
		this.el.addEventListener("pointermove", (e) => Math.abs(e.movementY) + Math.abs(e.movementX) > 6 && cancel());
		this.el.addEventListener("click", (e) => {
			if (this.suppressClick && e.target.closest('.tab[data-tab="profile"], [data-drawer]')) {
				e.stopPropagation();
				e.preventDefault();
				this.suppressClick = false;
			}
		}, true);
		this.el.addEventListener("contextmenu", (e) => e.target.closest(".tab, [data-drawer]") && e.preventDefault());
		this.notifications.on(() => this.updateBadges());
	}

	get current() {
		return this.roots.get(this.active?.key);
	}

	// swap the whole app to another account (and its instance)
	switchTo(key, { quiet = false } = {}) {
		const acct = store.account(key);
		if (!acct) return;
		const prevRoot = this.current;
		store.setActive(key);
		this.active = acct;
		let root = this.roots.get(key);
		if (!root) {
			root = new AccountRoot(this, acct);
			this.roots.set(key, root);
			this.rootsEl.append(root.el);
			root.selectTab("home");
		}
		if (prevRoot && prevRoot !== root) {
			prevRoot.el.classList.remove("active");
			prevRoot.stack?.top?.hide();
			root.stack?.top?.show();
		}
		root.el.classList.add("active");
		if (!quiet) {
			haptic(12);
			root.el.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
			banner({ title: `@${acct.user.screen_name}`, body: `Now using ${acct.instance}`, avatar: acct.user.avatar_url, timeout: 1800 });
		}
		this.el.classList.remove("bar-hidden");
		this.updateChrome();
		this.updateBadges();
		this.notifications.check(acct);
		if (acct.expired) this.promptReauth(acct);
	}

	updateChrome() {
		const root = this.current;
		if (!root) return;
		$$(".tabbar .tab", this.el).forEach((b) => b.classList.toggle("on", b.dataset.tab === root.tab));
		const av = $(".tab-av", this.el);
		if (av) av.innerHTML = avatar(this.active.user, "av");
		const depth = root.stack?.pages.length ?? 1;
		this.el.classList.toggle("deep", depth > 1);
		this.el.classList.toggle("on-profile-root", root.tab === "profile" && depth === 1);
	}

	updateBadges() {
		if (!this.active) return;
		const n = this.notifications.unread.get(this.active.key) || 0;
		const badge = $(".tab-badge", this.el);
		if (badge) {
			badge.hidden = !n;
			badge.textContent = n > 99 ? "99+" : String(n);
		}
		const others = this.notifications.totalOthers(this.active.key);
		$$(".badge-dot", document).forEach((d) => (d.hidden = !others));
	}

	isOnNotifications() {
		const r = this.current;
		return r?.tab === "notifications" && r.stack.pages.length === 1 && !document.hidden;
	}

	openNotification(key, postId, { money = false } = {}) {
		if (key && key !== this.active?.key) this.switchTo(key);
		const r = this.current;
		if (r.tab !== "notifications") r.selectTab("notifications");
		else if (r.stack.pages.length > 1) r.stack.popToRoot();
		this.updateChrome();
		if (postId) setTimeout(() => r.open("post", { id: postId }), 60);
		else if (money) setTimeout(() => r.open("money"), 60);
	}

	handleHash() {
		const h = location.hash;
		if (!h) return;
		history.replaceState(null, "", location.pathname + location.search);
		if (h === "#compose") this.current.compose();
		else if (h === "#notifications") this.openNotification(this.active.key);
		else if (h.startsWith("#open=")) {
			try {
				const m = JSON.parse(decodeURIComponent(h.slice(6)));
				this.openNotification(m.key, m.post, { money: m.money });
			} catch {}
		}
	}

	// ---- accounts

	addAccount() {
		addAccountFlow({
			onDone: (acct) => {
				toast(`Added @${acct.user.screen_name} on ${acct.instance}`);
				this.switchTo(acct.key);
				this.notifications.check(acct);
			},
		});
	}

	signOut(key) {
		const root = this.roots.get(key);
		root?.destroy();
		this.roots.delete(key);
		store.removeAccount(key);
		this.notifications.unread.delete(key);
		this.notifications.items.delete(key);
		if (!store.accounts().length) return location.reload();
		if (this.active?.key === key) this.switchTo(store.accounts()[0].key);
		this.updateBadges();
	}

	authFailed(key) {
		const a = store.account(key);
		if (!a || a.expired) return;
		store.updateAccount(key, { expired: true });
		if (key === this.active?.key) this.promptReauth({ ...a, expired: true });
	}
	promptReauth(a) {
		banner({
			title: `Sign in again to @${a.user.screen_name}`,
			body: `${a.instance} didn't accept this app's access any more. Tap to sign in.`,
			avatar: a.user.avatar_url,
			timeout: 8000,
			onTap: () => (a.method === "oauth" ? reauthorize(a) : addAccountFlow({ instance: a.instance, onDone: (n) => this.switchTo(n.key) })),
		});
	}

	async refreshProfiles() {
		for (const a of store.accounts()) {
			try {
				const me = await apiFor(a).me();
				store.updateAccount(a.key, { user: me, expired: false });
				if (a.key === this.active?.key) this.active = store.account(a.key);
			} catch {}
		}
		this.updateChrome();
	}

	// ---- drawer and switcher

	openDrawer() {
		const a = this.active;
		const others = store.accounts().filter((x) => x.key !== a.key);
		const u = a.user;
		const d = el(`<div class="drawer-wrap"><div class="drawer-backdrop"></div><aside class="drawer">
			<div class="drawer-top">
				<button class="drawer-me press" data-go="profile">${avatar(u, "av md")}</button>
				<div class="drawer-others">${others.slice(0, 3).map((o) => `<button class="press" data-switch="${esc(o.key)}" title="@${esc(o.user.screen_name)} · ${esc(o.instance)}">${avatar(o.user, "av sm")}${this.notifications.unread.get(o.key) ? `<span class="badge-dot"></span>` : ""}</button>`).join("")}
					<button class="drawer-more press" data-switcher aria-label="Switch accounts">${icon("more")}</button></div>
			</div>
			<div class="drawer-names" data-go="profile"><b>${esc(u.name || u.screen_name)}</b><span>@${esc(u.screen_name)}</span><span class="instance-chip">${icon("globe")}${esc(a.instance)}</span></div>
			${u.counts ? `<div class="drawer-counts"><span><b>${u.counts.following}</b> Following</span><span><b>${u.counts.followers}</b> Followers</span></div>` : ""}
			<nav class="drawer-menu">
				<button class="press" data-go="profile">${icon("user")}Profile</button>
				<button class="press" data-go="explore">${icon("globe")}Explore ${esc(a.instance)}</button>
				${moneyKnown(a)?.on === false ? "" : `<button class="press" data-go="money">${icon("money")}Equicoins</button>`}
				<button class="press" data-switcher>${icon("swap")}Switch account</button>
				<button class="press" data-go="settings">${icon("gear")}Settings</button>
			</nav>
		</aside></div>`);
		document.getElementById("overlay-root").append(d);
		const panel = d.querySelector(".drawer");
		const shift = this.rootsEl;
		const w = () => panel.offsetWidth;
		panel.animate([{ transform: "translate3d(-100%,0,0)" }, { transform: "none" }], { duration: 380, easing: EASE });
		d.querySelector(".drawer-backdrop").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
		const opened = shift.animate([{ transform: "none" }, { transform: `translate3d(${w() * 0.25}px,0,0)` }], { duration: 380, easing: EASE, fill: "forwards" });
		let closed = false;
		const close = (fromHistory) => {
			if (closed) return;
			closed = true;
			if (fromHistory !== true) dropBack(close);
			const cur = new DOMMatrix(getComputedStyle(panel).transform).m41;
			panel.animate([{ transform: `translate3d(${cur}px,0,0)` }, { transform: "translate3d(-100%,0,0)" }], { duration: 300, easing: EASE, fill: "forwards" });
			shift.animate([{ transform: `translate3d(${w() * 0.25 * (1 + cur / w())}px,0,0)` }, { transform: "none" }], { duration: 300, easing: EASE, fill: "forwards" }).onfinish = (ev) => {
				opened.cancel();
				ev.target.cancel();
			};
			d.querySelector(".drawer-backdrop").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).onfinish = () => d.remove();
		};
		pushBack(close);
		d.querySelector(".drawer-backdrop").onclick = () => close();
		d.addEventListener("click", (e) => {
			const go = e.target.closest("[data-go]");
			const sw = e.target.closest("[data-switch]");
			const more = e.target.closest("[data-switcher]");
			if (!go && !sw && !more) return;
			close();
			setTimeout(() => {
				if (sw) this.switchTo(sw.dataset.switch);
				else if (more) this.openSwitcher();
				else if (go.dataset.go === "profile") {
					this.current.selectTab("profile");
					this.updateChrome();
				} else this.current.open(go.dataset.go);
			}, 120);
		});
		// swipe left to close
		let x0 = null, dx = 0;
		panel.addEventListener("touchstart", (e) => ((x0 = e.touches[0].clientX), (dx = 0)), { passive: true });
		panel.addEventListener("touchmove", (e) => {
			if (x0 === null) return;
			dx = Math.min(0, e.touches[0].clientX - x0);
			panel.style.transform = `translate3d(${dx}px,0,0)`;
		}, { passive: true });
		panel.addEventListener("touchend", () => {
			if (x0 === null) return;
			x0 = null;
			if (dx < -60) close();
			else {
				panel.animate([{ transform: `translate3d(${dx}px,0,0)` }, { transform: "none" }], { duration: 220, easing: EASE });
				panel.style.transform = "";
			}
		});
	}

	openSwitcher() {
		const list = store.accounts();
		const body = el(`<div class="switcher"><div class="switcher-title">Accounts</div>
			<div class="sheet-scroll">${list
				.map((a) => {
					const n = this.notifications.unread.get(a.key) || 0;
					return `<button class="switch-row press ${a.key === this.active.key ? "current" : ""}" data-key="${esc(a.key)}">${avatar(a.user, "av md")}<div class="row-main"><b>${esc(a.user.name || a.user.screen_name)}</b><span>@${esc(a.user.screen_name)}</span><span class="instance-chip">${icon("globe")}${esc(a.instance)}</span>${a.expired ? `<span class="warn">Sign in again</span>` : ""}</div>${n ? `<span class="count-badge">${n > 99 ? "99+" : n}</span>` : ""}${a.key === this.active.key ? `<span class="check">${icon("check")}</span>` : ""}</button>`;
				})
				.join("")}</div>
			<div class="switcher-actions"><button class="pill-btn outline wide" data-add>Add an existing account</button><button class="text-btn" data-manage>Manage accounts</button></div></div>`);
		const s = sheet(body);
		body.addEventListener("click", (e) => {
			const row = e.target.closest("[data-key]");
			if (row) {
				s.close();
				if (row.dataset.key !== this.active.key) setTimeout(() => this.switchTo(row.dataset.key), 150);
				return;
			}
			if (e.target.closest("[data-add]")) {
				s.close();
				setTimeout(() => this.addAccount(), 200);
			}
			if (e.target.closest("[data-manage]")) {
				s.close();
				setTimeout(() => this.current.open("settings"), 200);
			}
		});
	}

	async requestNotifications() {
		if (typeof Notification === "undefined") {
			const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
			return toast(standalone ? "This browser can't show notifications" : "Add Xitter to your Home Screen first (Share → Add to Home Screen)", { error: true });
		}
		const p = await Notification.requestPermission();
		if (p === "granted") {
			toast("Notifications are on");
			this.notifications.registerBackground();
			this.notifications.checkAll();
		} else if (p === "denied") toast("Notifications are blocked in your browser's settings", { error: true });
	}

	registerWorker() {
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("sw.js").catch(() => {});
	}
}

const app = new App();
window.__xitter = app;
app.start();
