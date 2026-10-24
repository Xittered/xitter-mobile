// Equicoins: the instance's own play money, with no cash value. The Equicoins
// screen (balance, Send, Request, what's waiting, activity), the send and
// request sheets, and the cards payment and request links become in posts.

import { Page, actionSheet, sheet, toast } from "./nav.js";
import { $, $$, ago, avatar, debounce, el, esc, haptic, icon, verifiedBadge } from "./util.js";

// "$1,234.50"; whole amounts without their cents, as X shows them ("$100")
export const formatCents = (cents, { short = false } = {}) => {
	const n = Math.max(0, Math.round(Number(cents) || 0));
	const dollars = Math.floor(n / 100).toLocaleString("en-US");
	return short && n % 100 === 0 ? `$${dollars}` : `$${dollars}.${String(n % 100).padStart(2, "0")}`;
};
// what someone typed as an amount, in cents (null when it isn't one)
export function parseCents(text) {
	const m = /^\$?\s*(\d{1,9})(?:\.(\d{0,2}))?$/.exec(String(text ?? "").trim().replace(/,/g, ""));
	if (!m) return null;
	const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
	return cents > 0 ? cents : null;
}

// whether this account's instance has Equicoins on, remembered for a day
const supportKey = (key) => `xit.money.${key}`;
export function moneyKnown(account) {
	try {
		const v = JSON.parse(localStorage.getItem(supportKey(account.key)) || "null");
		return v && Date.now() - v.at < 864e5 ? v : null;
	} catch {
		return null;
	}
}
function remember(account, on, accepted) {
	try {
		localStorage.setItem(supportKey(account.key), JSON.stringify({ on, accepted, at: Date.now() }));
	} catch {}
}
export async function moneyStatus(ctx) {
	try {
		const w = await ctx.api.money();
		remember(ctx.account, true, w.disclaimer_accepted);
		return w;
	} catch (e) {
		if (e.status === 404) remember(ctx.account, false, false);
		throw e;
	}
}

// links to this instance's payments and requests: "p123" or "r123"
export function moneyKeyOf(href, api) {
	try {
		const u = new URL(href);
		if (u.origin !== api.origin) return null;
		const m = /^\/i\/xmoney\/([pr])\/(\d{1,19})\/?$/.exec(u.pathname);
		return m ? m[1] + m[2] : null;
	} catch {
		return null;
	}
}

const who = (u) => u?.name || u?.screen_name || "someone";
const local = (u) => !String(u?.screen_name || "").includes("@");

// ---- cards in posts

export function paymentCardHtml(t) {
	const shop = t.merchant;
	return `<div class="money-card press" data-act="money-card" data-money="p${esc(t.id)}">
		${shop?.banner_url ? `<div class="mc-banner" style="background-image:url('${esc(shop.banner_url)}')"></div>` : ""}
		<div class="mc-row">${avatar(t.sender, "av sm")}<span class="mc-arrow">${icon("back", "flip")}</span>${avatar(t.recipient, "av sm")}</div>
		<div class="mc-title">${t.reversed ? "<s>" : ""}${formatCents(t.amount_cents, { short: true })}${t.reversed ? "</s>" : ""} ${shop ? `at <b>${esc(shop.name)}</b>` : `sent to <b>${esc(who(t.recipient))}</b>`}</div>
		${t.note ? `<div class="mc-note">${esc(t.note)}</div>` : ""}
		<div class="mc-foot"><span class="mc-mark">${icon("money")}Equicoins</span><span>${t.reversed ? "Reversed" : ago(t.created_at)}</span></div>
	</div>`;
}

export function requestCardHtml(q) {
	const done = q.status !== "open";
	const status = { paid: "Paid", declined: "Declined", cancelled: "Cancelled" }[q.status];
	return `<div class="money-card press" data-act="money-card" data-money="r${esc(q.id)}">
		<div class="mc-row">${avatar(q.requester, "av md")}</div>
		<div class="mc-title">Pay <b>@${esc(q.requester.screen_name)}</b>${verifiedBadge(q.requester)}</div>
		<div class="mc-amount">${q.amount_cents ? formatCents(q.amount_cents, { short: true }) : "Any amount"}</div>
		${q.note ? `<div class="mc-note">${esc(q.note)}</div>` : ""}
		${q.payer ? "" : q.paid_count ? `<div class="mc-note dim">Paid ${q.paid_count} time${q.paid_count === 1 ? "" : "s"}</div>` : ""}
		${q.can_pay ? `<button class="pill-btn money-pay" data-act="money-pay" data-rid="${esc(q.id)}" data-to="${esc(q.requester.screen_name)}" data-amount="${q.amount_cents ?? ""}" data-note="${esc(q.note || "")}">Pay</button>` : done ? `<div class="mc-status">${status}</div>` : ""}
		<div class="mc-foot"><span class="mc-mark">${icon("money")}Equicoins</span><span>${ago(q.created_at)}</span></div>
	</div>`;
}

// turn a post's money links into cards (called from hydrate)
export function hydrateMoney(root, api) {
	for (const post of $$(".post:not([data-money-done])", root)) {
		post.dataset.moneyDone = "1";
		const links = $$(".text a.lnk[href]", post).filter((a) => moneyKeyOf(a.href, api));
		if (!links.length) continue;
		const slot = el(`<div class="money-slot"></div>`);
		(post.querySelector(".text")?.nextElementSibling?.classList.contains("show-more") ? post.querySelector(".show-more") : post.querySelector(".text")).after(slot);
		for (const a of links.slice(0, 2)) {
			const key = moneyKeyOf(a.href, api);
			const place = el(`<div class="money-card skeleton"></div>`);
			slot.append(place);
			(key[0] === "p" ? api.payment(key.slice(1)).then(paymentCardHtml) : api.moneyRequest(key.slice(1)).then(requestCardHtml)).then(
				(html) => {
					place.outerHTML = html;
					a.classList.add("money-link"); // the card says it; the link text doesn't need to
				},
				() => place.remove(),
			);
		}
	}
}

// ---- sending and asking

const keyFor = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "");

// a username field that suggests accounts on this instance (money stays here)
function suggestFor(input, box, api) {
	const look = debounce(async () => {
		const q = input.value.trim().replace(/^@/, "");
		if (!q) return void (box.innerHTML = "");
		try {
			const users = (await api.searchUsers(q, 8)).filter(local).slice(0, 5);
			if (input.value.trim().replace(/^@/, "") !== q) return;
			box.innerHTML = users.map((u) => `<button type="button" class="mention-row press" data-name="${esc(u.screen_name)}">${avatar(u, "av sm")}<span class="mention-names"><b>${esc(who(u))}${verifiedBadge(u)}</b><span>@${esc(u.screen_name)}</span></span></button>`).join("");
		} catch {}
	}, 150);
	input.addEventListener("input", look);
	box.addEventListener("pointerdown", (e) => e.preventDefault());
	box.addEventListener("click", (e) => {
		const row = e.target.closest("[data-name]");
		if (!row) return;
		input.value = row.dataset.name;
		box.innerHTML = "";
		input.dispatchEvent(new Event("change"));
	});
}

function successView(sheetEl, { title, sub, url, ctx, close }) {
	sheetEl.querySelector(".money-sheet").innerHTML = `<div class="money-done">
		<div class="money-check">${icon("check")}</div>
		<h2>${title}</h2>${sub ? `<p class="dim">${sub}</p>` : ""}
		${url ? `<button class="pill-btn solid wide" data-share>Share it in a post</button>` : ""}
		<button class="pill-btn outline wide" data-done>Done</button></div>`;
	haptic(20);
	sheetEl.querySelector("[data-share]")?.addEventListener("click", () => {
		close();
		setTimeout(() => ctx.compose({ text: `\n\n${url}` }), 250);
	});
	sheetEl.querySelector("[data-done]").addEventListener("click", close);
}

// send money: to anyone here, or to pay a request
export function openSend(ctx, { to = "", amountCents = null, requestId = null, note = "", onDone } = {}) {
	const fixedAmount = !!(requestId && amountCents);
	const idem = keyFor();
	const body = el(`<div class="money-sheet">
		<div class="money-head"><span class="mc-mark">${icon("money")}Equicoins</span><b>${requestId ? "Pay request" : "Send"}</b><span></span></div>
		<label class="money-field"><span>To</span><input name="to" placeholder="username" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(to)}" ${requestId ? "readonly" : ""}></label>
		<div class="mention-box money-suggest"></div>
		<div class="money-amount"><span>$</span><input name="amount" inputmode="decimal" placeholder="0" value="${amountCents ? (amountCents / 100).toFixed(2).replace(/\.00$/, "") : ""}" ${fixedAmount ? "readonly" : ""}></div>
		<label class="money-field"><span>Note</span><input name="note" maxlength="140" placeholder="What's it for?" value="${esc(note)}"></label>
		<button class="pill-btn solid wide big" data-send disabled>Send</button>
		<p class="fine center">Instant and free. ${esc(ctx.account.instance)} Equicoins has no cash value.</p>
	</div>`);
	const s = sheet(body, { className: "money-wrap", onClose: () => onDone?.() });
	const toIn = $("[name=to]", body), amountIn = $("[name=amount]", body), noteIn = $("[name=note]", body), send = $("[data-send]", body);
	if (!requestId) suggestFor(toIn, $(".money-suggest", body), ctx.api);
	const update = () => {
		const cents = parseCents(amountIn.value);
		send.disabled = !cents || !toIn.value.trim();
		send.textContent = cents ? `Send ${formatCents(cents)}` : "Send";
	};
	[toIn, amountIn].forEach((i) => i.addEventListener("input", update));
	toIn.addEventListener("change", () => (update(), amountIn.focus()));
	update();
	(to ? (fixedAmount ? noteIn : amountIn) : toIn).focus();
	send.addEventListener("click", async () => {
		const cents = parseCents(amountIn.value);
		if (!cents) return;
		send.disabled = true;
		send.innerHTML = `<span class="mini-spin"></span>`;
		try {
			const t = await ctx.api.sendMoney({ to: toIn.value.trim().replace(/^@/, ""), amount_cents: cents, note: noteIn.value.trim(), idempotency_key: idem, ...(requestId ? { request_id: requestId } : {}) });
			successView(s.el, { title: `${formatCents(t.amount_cents, { short: true })} sent`, sub: `to ${esc(who(t.recipient))}`, url: t.url, ctx, close: s.close });
		} catch (e) {
			toast(e.message, { error: true });
			update();
		}
	});
}

// ask for money: of one account, or of anyone with a "Pay @you" card
export function openRequest(ctx, { onDone } = {}) {
	const body = el(`<div class="money-sheet">
		<div class="money-head"><span class="mc-mark">${icon("money")}Equicoins</span><b>Request</b><span></span></div>
		<label class="money-field"><span>From</span><input name="from" placeholder="anyone (a Pay button)" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
		<div class="mention-box money-suggest"></div>
		<div class="money-amount"><span>$</span><input name="amount" inputmode="decimal" placeholder="0"></div>
		<label class="money-field"><span>Note</span><input name="note" maxlength="140" placeholder="What's it for?"></label>
		<button class="pill-btn solid wide big" data-ask>Request</button>
		<p class="fine center">With nobody in From, anyone who sees your Pay button can pay any amount, or the amount you set.</p>
	</div>`);
	const s = sheet(body, { className: "money-wrap", onClose: () => onDone?.() });
	const fromIn = $("[name=from]", body), amountIn = $("[name=amount]", body), noteIn = $("[name=note]", body), ask = $("[data-ask]", body);
	suggestFor(fromIn, $(".money-suggest", body), ctx.api);
	const update = () => {
		const from = fromIn.value.trim(), cents = parseCents(amountIn.value);
		ask.disabled = !!from && !cents;
		ask.textContent = from ? `Request${cents ? ` ${formatCents(cents)}` : ""} from @${from.replace(/^@/, "")}` : "Make a Pay button";
	};
	[fromIn, amountIn].forEach((i) => i.addEventListener("input", update));
	fromIn.addEventListener("change", () => (update(), amountIn.focus()));
	update();
	amountIn.focus();
	ask.addEventListener("click", async () => {
		const from = fromIn.value.trim().replace(/^@/, ""), cents = parseCents(amountIn.value);
		ask.disabled = true;
		ask.innerHTML = `<span class="mini-spin"></span>`;
		try {
			const q = await ctx.api.requestMoney({ ...(from ? { from } : {}), ...(cents ? { amount_cents: cents } : {}), note: noteIn.value.trim() });
			successView(s.el, from ? { title: "Request sent", sub: `@${esc(from)} can pay or decline it.`, url: null, ctx, close: s.close } : { title: "Your Pay button is ready", sub: "Share it in a post and anyone can pay you.", url: q.url, ctx, close: s.close });
		} catch (e) {
			toast(e.message, { error: true });
			update();
		}
	});
}

// ---- the Equicoins screen

function activityRow(t) {
	const sent = t.direction === "sent", other = sent ? t.recipient : t.sender;
	const what = sent ? (t.merchant ? `At ${esc(t.merchant.name)}` : `Sent to ${esc(who(other))}`) : `From ${esc(who(other))}`;
	return `<button class="money-row press" data-payment="${esc(t.id)}">${avatar(other, "av md")}
		<span class="mr-main"><b>${what}</b><span>${t.note ? esc(t.note) + " · " : ""}${ago(t.created_at)}${t.reversed ? " · Reversed" : ""}</span></span>
		<span class="mr-amount ${sent ? "" : "in"} ${t.reversed ? "reversed" : ""}">${sent ? "−" : "+"}${formatCents(t.amount_cents)}</span></button>`;
}
function earningRow(e) {
	return `<div class="money-row"><span class="mr-icon">${icon("heart-f")}</span>
		<span class="mr-main"><b>Likes paid you</b><span>${e.likes} like${e.likes === 1 ? "" : "s"} · ${new Date(`${e.day}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}</span></span>
		<span class="mr-amount in">+${formatCents(e.cents)}</span></div>`;
}
function waitingRow(q, me) {
	const mine = q.requester.screen_name.toLowerCase() === me.toLowerCase();
	const other = mine ? q.payer : q.requester;
	return `<div class="money-row waiting" data-request="${esc(q.id)}">${avatar(other, "av md")}
		<span class="mr-main"><b>${mine ? `You asked ${esc(who(other))}` : `${esc(who(other))} asked you`}</b><span>${q.note ? esc(q.note) + " · " : ""}${ago(q.created_at)}</span></span>
		<span class="mr-side"><span class="mr-amount">${formatCents(q.amount_cents)}</span>
		${q.can_pay ? `<button class="pill-btn solid small" data-pay="${esc(q.id)}">Pay</button>` : ""}
		${q.can_decline ? `<button class="text-btn small" data-close="decline">Decline</button>` : ""}
		${q.can_cancel ? `<button class="text-btn small" data-close="cancel">Cancel</button>` : ""}</span></div>`;
}

export class MoneyPage extends Page {
	constructor(ctx) {
		super(ctx);
		this.el = el(`<section class="page money-page">
			<header class="bar"><div class="bar-row"><button class="bar-btn back press" data-back aria-label="Back">${icon("back")}</button><div class="bar-title"><b>Equicoins</b><span>${esc(ctx.account.instance)}</span></div><div class="bar-right"></div></div></header>
			<div class="scroll"><div class="money-body"><div class="loading"><div class="spinner"></div></div></div></div></section>`);
		this.body = $(".money-body", this.el);
		this.el.addEventListener("click", (e) => this.click(e));
		this.load();
	}
	async load() {
		try {
			this.wallet = await moneyStatus(this.ctx);
		} catch (e) {
			this.body.innerHTML = `<div class="empty"><b>${e.status === 404 ? "Equicoins isn't here yet" : "Couldn't open Equicoins"}</b><p>${e.status === 404 ? `${esc(this.ctx.account.instance)} doesn't have Equicoins turned on.` : esc(e.message)}</p></div>`;
			return;
		}
		if (!this.wallet.disclaimer_accepted) return this.disclaimer();
		this.render();
		this.refresh();
	}
	disclaimer() {
		this.body.innerHTML = `<div class="money-welcome"><div class="money-tile">${icon("money")}</div><h1>Welcome to ${esc(this.wallet.name)}</h1>
			<p><b>Disclaimer:</b> ${esc(this.wallet.disclaimer)}</p><button class="pill-btn solid wide big" data-accept>I understand</button></div>`;
	}
	render() {
		const w = this.wallet;
		this.body.innerHTML = `<div class="wallet">
				<span class="wallet-label">Balance</span><div class="wallet-amount">${formatCents(w.balance_cents)}</div>
				<div class="wallet-actions"><button class="pill-btn solid" data-wallet-send>Send</button><button class="pill-btn outline" data-wallet-request>Request</button></div>
				<p class="fine">Likes on your posts pay you ${formatCents(w.like_cents, { short: true })} each. ${esc(w.name)} has no cash value.</p></div>
			<div class="money-waiting"></div>
			<div class="group-label">Activity</div><div class="money-activity"><div class="loading"><div class="spinner"></div></div></div>`;
	}
	async refresh() {
		const api = this.ctx.api;
		const [wallet, waiting, act] = await Promise.allSettled([api.money(), api.moneyRequests(), api.moneyActivity()]);
		if (wallet.status === "fulfilled") {
			this.wallet = wallet.value;
			const amt = $(".wallet-amount", this.el);
			if (amt) amt.textContent = formatCents(this.wallet.balance_cents);
		}
		if (waiting.status === "fulfilled") {
			const list = waiting.value;
			$(".money-waiting", this.el).innerHTML = list.length ? `<div class="group-label">Waiting</div>${list.map((q) => waitingRow(q, this.ctx.account.user.screen_name)).join("")}` : "";
		}
		const box = $(".money-activity", this.el);
		if (act.status === "fulfilled") {
			const out = act.value;
			this.cursor = out.next_cursor;
			this.payments = new Map(out.data.map((t) => [t.id, t]));
			// earnings by day sit among the payments by date
			const rows = [...out.data.map((t) => ({ at: Date.parse(t.created_at), html: activityRow(t) })), ...(out.earnings || []).map((e) => ({ at: Date.parse(`${e.day}T23:59:59Z`), html: earningRow(e) }))].sort((a, b) => b.at - a.at);
			box.innerHTML = rows.length ? rows.map((r) => r.html).join("") + (this.cursor ? `<button class="text-btn more-btn" data-more>Show more</button>` : "") : `<div class="empty"><p>Payments you send and receive show up here.</p></div>`;
		} else box.innerHTML = `<div class="empty"><p>${esc(act.reason.message)}</p></div>`;
	}
	async more(btn) {
		btn.innerHTML = `<span class="mini-spin"></span>`;
		try {
			const out = await this.ctx.api.moneyActivity(this.cursor);
			this.cursor = out.next_cursor;
			for (const t of out.data) this.payments.set(t.id, t);
			btn.insertAdjacentHTML("beforebegin", out.data.map(activityRow).join(""));
			if (this.cursor) btn.textContent = "Show more";
			else btn.remove();
		} catch (e) {
			btn.textContent = "Show more";
			toast(e.message, { error: true });
		}
	}
	async click(e) {
		const t = e.target, ctx = this.ctx;
		if (t.closest("[data-back]")) return ctx.back();
		if (t.closest("[data-accept]")) {
			try {
				await ctx.api.acceptMoneyDisclaimer();
				this.wallet.disclaimer_accepted = true;
				moneyStatus(ctx).catch(() => {});
				// from now on, money in and requests are notifications
				ctx.app.notifications?.check(ctx.account);
				this.render();
				this.refresh();
			} catch (err) {
				toast(err.message, { error: true });
			}
			return;
		}
		if (t.closest("[data-wallet-send]")) return openSend(ctx, { onDone: () => this.refresh() });
		if (t.closest("[data-wallet-request]")) return openRequest(ctx, { onDone: () => this.refresh() });
		const pay = t.closest("[data-pay]");
		if (pay) {
			const q = (await ctx.api.moneyRequests()).find((x) => x.id === pay.dataset.pay);
			if (q) openSend(ctx, { to: q.requester.screen_name, amountCents: q.amount_cents, requestId: q.id, note: q.note, onDone: () => this.refresh() });
			return;
		}
		const close = t.closest("[data-close]");
		if (close) {
			const id = close.closest("[data-request]").dataset.request, action = close.dataset.close;
			if (!(await actionSheet([{ label: action === "decline" ? "Decline request" : "Cancel request", danger: true, value: true }]))) return;
			try {
				await ctx.api.closeMoneyRequest(id, action);
				toast(action === "decline" ? "Request declined" : "Request cancelled");
				this.refresh();
			} catch (err) {
				toast(err.message, { error: true });
			}
			return;
		}
		const more = t.closest("[data-more]");
		if (more) return this.more(more);
		const row = t.closest("[data-payment]");
		if (row) {
			const p = this.payments?.get(row.dataset.payment);
			if (!p) return;
			const other = p.direction === "sent" ? p.recipient : p.sender;
			const choice = await actionSheet([
				{ label: "Share it in a post", icon: "share", value: "share" },
				...(local(other) ? [{ label: p.direction === "sent" ? `Send @${other.screen_name} more` : `Send @${other.screen_name} money`, icon: "money", value: "send" }] : []),
				{ label: `View @${other.screen_name}`, icon: "user", value: "profile" },
			], { title: `${formatCents(p.amount_cents)} ${p.direction === "sent" ? `to ${esc(who(other))}` : `from ${esc(who(other))}`}` });
			if (choice === "share") ctx.compose({ text: `\n\n${p.url}` });
			if (choice === "send") openSend(ctx, { to: other.screen_name, onDone: () => this.refresh() });
			if (choice === "profile") ctx.open("profile", { name: other.screen_name });
		}
	}
	show() {
		if (this.wallet?.disclaimer_accepted) this.refresh();
	}
}
