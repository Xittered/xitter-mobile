// The composer: a full-height sheet for a post, reply, quote or thread, with
// photos and videos uploading while you type, @mention suggestions, a content
// warning for media, and a choice of which account to post as.

import { apiFor } from "./api.js";
import { formatCents, moneyKnown, moneyStatus } from "./money.js";
import { actionSheet, sheet, toast } from "./nav.js";
import { accounts } from "./store.js";
import { $, $$, avatar, debounce, el, esc, haptic, icon, richText, verifiedBadge } from "./util.js";

const draftKey = (key) => `xit.draft.${key}`;
const limitKey = (key) => `xit.limit.${key}`;
const MAX_PARTS = 25;

// Post length the way Xitter counts it (src/textlen.ts): a link is 23 however
// long, wide characters (CJK, emoji) 2, everything else 1
export function weightedLength(text) {
	let n = 0;
	const rest = text.normalize("NFC").replace(/https?:\/\/\S+/g, () => {
		n += 23;
		return "";
	});
	for (const c of rest) {
		const cp = c.codePointAt(0);
		n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
	}
	return n;
}

// Xitter's default limits by badge (Admin > Settings can change them; a refusal
// tells us the real one, which is remembered per account)
function limitFor(account) {
	try {
		const learned = Number(localStorage.getItem(limitKey(account.key)));
		if (learned > 0) return learned;
	} catch {}
	const t = String(account.user.verified_type || "").toLowerCase();
	return t.startsWith("government") ? 256000 : t === "business" ? 128000 : t === "blue" ? 25000 : 4000;
}

const readDraft = (key) => {
	try {
		return JSON.parse(localStorage.getItem(draftKey(key)) || "null");
	} catch {
		return null;
	}
};

export function compose(ctx, { replyTo, quote, text = "" } = {}) {
	// replies and quotes point at a post on this account's instance; a new post
	// can go out from any signed-in account
	const canSwitch = !replyTo && !quote && accounts().length > 1;
	let account = ctx.account;
	let api = ctx.api;
	const fresh = !replyTo && !quote && !text;
	const saved = fresh ? readDraft(account.key) : null;
	// a thread is a list of parts; each part has text and media
	let parts = (saved?.length ? saved : [{ text }]).map((p) => ({ text: p.text || "", media: [] }));
	let active = 0;
	let sending = false;
	let sensitive = false;
	let parent = replyTo?.id, firstPost = null, postedCount = 0;
	let discard = false;

	const root = el(`<div class="compose">
		<div class="compose-bar">
			<button class="text-btn" data-cancel>Cancel</button>
			<button class="as-chip ${canSwitch ? "press" : ""}" data-as ${canSwitch ? "" : "disabled"}></button>
			<button class="pill-btn solid" data-send disabled>${replyTo ? "Reply" : "Post"}</button>
		</div>
		<div class="compose-scroll sheet-scroll">
			${replyTo ? `<div class="compose-context"><div class="cc-left">${avatar(replyTo.author, "av sm")}<i class="cc-line"></i></div><div class="cc-body"><div class="cc-name"><b>${esc(replyTo.author.name || replyTo.author.screen_name)}</b> <span>@${esc(replyTo.author.screen_name)}</span></div><div class="cc-text">${richText(replyTo.text || "")}</div><div class="cc-to">Replying to <span class="accent-text">@${esc(replyTo.author.screen_name)}</span></div></div></div>` : ""}
			<div class="parts"></div>
			${quote ? `<div class="compose-quote"><div class="quote"><div class="quote-head">${avatar(quote.author, "av xs")}<b>${esc(quote.author.name || quote.author.screen_name)}</b> <span class="handle">@${esc(quote.author.screen_name)}</span></div><div class="text">${richText(quote.text || "")}</div></div></div>` : ""}
		</div>
		<div class="mention-box no-drag" hidden></div>
		<div class="compose-tools no-drag">
			<label class="tool" aria-label="Add photos or video">${icon("image")}<input type="file" accept="image/*,video/*" multiple hidden></label>
			<button class="tool" data-mention aria-label="Mention someone"><span class="at">@</span></button>
			<button class="tool cw" data-cw aria-label="Content warning" hidden>${icon("cw")}</button>
			<button class="tool" data-money aria-label="Equicoins" hidden>${icon("money")}</button>
			<span class="tools-end"><span class="count"></span><svg class="ring" viewBox="0 0 30 30"><circle cx="15" cy="15" r="12" class="ring-bg"/><circle cx="15" cy="15" r="12" class="ring-fg" stroke-dasharray="75.4" stroke-dashoffset="75.4"/></svg>${replyTo || quote ? "" : `<i class="tool-sep"></i><button class="tool add-part" aria-label="Add to thread">${icon("plus")}</button>`}</span>
		</div>
	</div>`);

	const vv = window.visualViewport;
	const s = sheet(root, {
		full: true,
		className: "compose-sheet",
		onClose: () => {
			vv?.removeEventListener("resize", onViewport);
			vv?.removeEventListener("scroll", onViewport);
			if (discard || sending === "done") return clearDraft();
			if (saveDraft()) toast("Draft saved");
		},
	});
	// keep the toolbar above the on-screen keyboard (iOS overlays it)
	const onViewport = () => s.wrap.style.setProperty("--kb", Math.max(0, innerHeight - vv.height - vv.offsetTop) + "px");
	vv?.addEventListener("resize", onViewport);
	vv?.addEventListener("scroll", onViewport);

	const partsEl = $(".parts", root);
	const send = $("[data-send]", root);
	const mentionBox = $(".mention-box", root);
	const textareas = () => $$("textarea", partsEl);

	function renderAs() {
		$("[data-as]", root).innerHTML = `${avatar(account.user, "av xs")}<span>@${esc(account.user.screen_name)} · ${esc(account.instance)}</span>${canSwitch ? `<svg class="ic chev" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="m7 10 5 5 5-5"/></svg>` : ""}`;
	}

	// the parts list is rebuilt only when parts are added or removed; typing and
	// uploads never replace a text box, so the keyboard and cursor stay put
	function renderParts() {
		partsEl.innerHTML = parts
			.map((p, i) => `<div class="part ${i === active ? "active" : ""}" data-i="${i}">
				<div class="part-left">${avatar(account.user, "av")}${i < parts.length - 1 ? `<i class="part-line"></i>` : ""}</div>
				<div class="part-body">
					<textarea rows="1" placeholder="${i === 0 ? (replyTo ? "Post your reply" : quote ? "Add a comment" : "What's happening?") : "Add another post"}" enterkeyhint="enter" autocapitalize="sentences"></textarea>
					<div class="part-media"></div>
				</div>
				${parts.length > 1 ? `<button class="part-x" data-rmpart="${i}" aria-label="Remove">${icon("close")}</button>` : ""}
			</div>`)
			.join("");
		textareas().forEach((ta, i) => {
			ta.value = parts[i].text;
			grow(ta);
			renderMedia(i);
		});
		update();
	}
	function renderMedia(i) {
		const box = partsEl.querySelector(`.part[data-i="${i}"] .part-media`);
		if (!box) return;
		const media = parts[i].media;
		box.className = `part-media n${media.length}`;
		box.innerHTML = media
			.map((m, j) => `<div class="pm ${sensitive ? "is-sensitive" : ""}" data-j="${j}">${m.kind === "video" ? `<video src="${m.preview}" muted playsinline preload="metadata"></video>` : `<img src="${m.preview}" alt="">`}<button class="pm-x" data-rm="${j}" aria-label="Remove">${icon("close")}</button>${m.id || m.error ? "" : `<div class="pm-progress"><i style="transform:scaleX(${m.progress || 0})"></i></div>`}${m.error ? `<div class="pm-error">${esc(m.error)}</div>` : ""}${sensitive ? `<span class="pm-cw">${icon("cw")} Content warning</span>` : ""}</div>`)
			.join("");
	}
	const grow = (ta) => {
		ta.style.height = "auto";
		ta.style.height = ta.scrollHeight + "px";
	};

	function update() {
		const limit = limitFor(account);
		const n = weightedLength(parts[active]?.text || "");
		const ring = $(".ring-fg", root), label = $(".count", root);
		// the ring shows the first 280 like X's; past that, a count of what's left
		const scale = n <= 280 ? 280 : limit;
		ring.style.strokeDashoffset = String(75.4 * (1 - Math.min(1, n / scale)));
		const left = limit - n;
		root.classList.toggle("near", left <= 20 && left >= 0);
		root.classList.toggle("over", left < 0);
		label.textContent = left < 0 || left <= 20 ? String(left) : n > 280 ? `${n.toLocaleString()} / ${limit.toLocaleString()}` : "";
		$(".ring", root).style.visibility = n ? "visible" : "hidden";
		const uploading = parts.some((x) => x.media.some((m) => !m.id && !m.error));
		const ok = parts.every((x) => (x.text.trim() || x.media.length || (quote && parts.length === 1)) && x.media.every((m) => m.id) && weightedLength(x.text) <= limit);
		send.disabled = !ok || !!sending;
		send.title = uploading ? "Waiting for uploads to finish" : "";
		const addPart = $(".add-part", root);
		if (addPart) addPart.disabled = !parts[active]?.text.trim() || parts.length >= MAX_PARTS;
		const hasMedia = parts.some((x) => x.media.length);
		$("[data-cw]", root).hidden = !hasMedia;
		$("[data-cw]", root).classList.toggle("on", sensitive && hasMedia);
	}

	function saveDraft() {
		if (!fresh) return false;
		try {
			if (parts.some((p) => p.text.trim())) {
				localStorage.setItem(draftKey(account.key), JSON.stringify(parts.map((p) => ({ text: p.text }))));
				return true;
			}
			localStorage.removeItem(draftKey(account.key));
		} catch {}
		return false;
	}
	const clearDraft = () => {
		try {
			localStorage.removeItem(draftKey(account.key));
		} catch {}
	};
	// saved as you type, so nothing is lost if the app is closed
	const autosave = debounce(saveDraft, 600);

	partsEl.addEventListener("input", (e) => {
		const ta = e.target.closest("textarea");
		if (!ta) return;
		parts[Number(ta.closest(".part").dataset.i)].text = ta.value;
		grow(ta);
		update();
		autosave();
		suggest(ta);
	});
	partsEl.addEventListener("focusin", (e) => {
		const part = e.target.closest(".part");
		if (!part) return;
		active = Number(part.dataset.i);
		$$(".part", partsEl).forEach((x) => x.classList.toggle("active", x === part));
		update();
	});
	partsEl.addEventListener("click", (e) => {
		const rm = e.target.closest("[data-rm]");
		if (rm) {
			const i = Number(rm.closest(".part").dataset.i);
			parts[i].media.splice(Number(rm.dataset.rm), 1);
			renderMedia(i);
			return update();
		}
		const rp = e.target.closest("[data-rmpart]");
		if (rp) {
			parts.splice(Number(rp.dataset.rmpart), 1);
			active = Math.min(active, parts.length - 1);
			renderParts();
			autosave();
		}
	});
	partsEl.addEventListener("keydown", (e) => {
		// ⌘/Ctrl+Enter posts
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send.click();
		}
		if (e.key === "Escape" && !mentionBox.hidden) mentionBox.hidden = true;
	});
	$(".add-part", root)?.addEventListener("click", () => {
		parts.splice(active + 1, 0, { text: "", media: [] });
		active++;
		renderParts();
		textareas()[active]?.focus();
	});

	// ---- media: picked, pasted or dropped
	function addFiles(files) {
		const i = active, p = parts[i];
		for (const file of files) {
			if (!/^(image|video)\//.test(file.type)) continue;
			if (p.media.length >= 4) {
				toast("You can add up to 4 photos or videos", { error: true });
				break;
			}
			const m = { kind: file.type.startsWith("video/") ? "video" : "image", preview: URL.createObjectURL(file), progress: 0 };
			p.media.push(m);
			const where = () => partsEl.querySelector(`.part[data-i="${parts.indexOf(p)}"] .pm[data-j="${p.media.indexOf(m)}"]`);
			api.upload(file, (x) => {
				m.progress = x;
				const bar = where()?.querySelector(".pm-progress i");
				if (bar) bar.style.transform = `scaleX(${x})`;
			}).then(
				(id) => {
					m.id = id;
					where()?.querySelector(".pm-progress")?.remove();
					update();
				},
				(err) => {
					m.error = err.message;
					if (parts.includes(p)) renderMedia(parts.indexOf(p));
					update();
				},
			);
		}
		renderMedia(i);
		update();
	}
	$("input[type=file]", root).addEventListener("change", (e) => {
		addFiles([...e.target.files]);
		e.target.value = "";
	});
	root.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files || [])];
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});
	root.addEventListener("dragover", (e) => e.preventDefault());
	root.addEventListener("drop", (e) => {
		e.preventDefault();
		addFiles([...(e.dataTransfer?.files || [])]);
	});
	$("[data-cw]", root).addEventListener("click", () => {
		sensitive = !sensitive;
		haptic(6);
		parts.forEach((_, i) => renderMedia(i));
		update();
	});

	// ---- Equicoins: a Pay button, or one of your payments, in the post
	const moneyBtn = $("[data-money]", root);
	const showMoney = (w) => (moneyBtn.hidden = !(w?.on ?? true) || !(w?.accepted ?? w?.disclaimer_accepted));
	const known = moneyKnown(account);
	if (known) showMoney(known);
	else moneyStatus({ api, account }).then((w) => showMoney({ on: true, accepted: w.disclaimer_accepted }), () => {});
	const addToPost = (url) => {
		const i = active, ta = textareas()[i];
		parts[i].text = (parts[i].text.trimEnd() + (parts[i].text.trim() ? "\n\n" : "") + url).trimStart();
		if (ta) {
			ta.value = parts[i].text;
			grow(ta);
			ta.focus();
		}
		update();
		autosave();
	};
	moneyBtn.addEventListener("click", async () => {
		const pick = await actionSheet([
			{ label: "Add a Pay button", icon: "money", value: "pay" },
			{ label: "Share one of your payments", icon: "share", value: "payment" },
		]);
		try {
			if (pick === "pay") addToPost((await api.requestMoney({})).url);
			if (pick === "payment") {
				const recent = (await api.moneyActivity()).data.slice(0, 8);
				if (!recent.length) return toast("You haven't sent or received any money yet");
				const t = await actionSheet(recent.map((p) => ({ label: `${p.direction === "sent" ? "−" : "+"}${formatCents(p.amount_cents)} ${p.direction === "sent" ? "to" : "from"} ${esc((p.direction === "sent" ? p.recipient : p.sender).name)}`, value: p.url })), { title: "Share a payment" });
				if (t) addToPost(t);
			}
		} catch (e) {
			toast(e.message, { error: true });
		}
	});

	// ---- @mentions: suggestions as you type
	let mentionAt = null; // { ta, start, end }
	const lookUp = debounce(async (q, ta) => {
		try {
			const users = q ? await api.searchUsers(q, 6) : [];
			if (!mentionAt || mentionAt.ta !== ta) return;
			if (!users.length) return void (mentionBox.hidden = true);
			mentionBox.innerHTML = users
				.map((u) => `<button class="mention-row press" data-name="${esc(u.screen_name)}">${avatar(u, "av sm")}<span class="mention-names"><b>${esc(u.name || u.screen_name)}${verifiedBadge(u)}</b><span>@${esc(u.screen_name)}</span></span></button>`)
				.join("");
			mentionBox.hidden = false;
		} catch {}
	}, 150);
	function suggest(ta) {
		const upto = ta.value.slice(0, ta.selectionStart);
		const m = /(^|[^\w@])@(\w{0,50}(?:@[\w.-]*)?)$/.exec(upto);
		if (!m) {
			mentionAt = null;
			mentionBox.hidden = true;
			return;
		}
		mentionAt = { ta, start: upto.length - m[2].length - 1, end: ta.selectionStart };
		lookUp(m[2], ta);
	}
	mentionBox.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the keyboard up
	mentionBox.addEventListener("click", (e) => {
		const row = e.target.closest("[data-name]");
		if (!row || !mentionAt) return;
		const { ta, start, end } = mentionAt;
		const insert = `@${row.dataset.name} `;
		ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
		const caret = start + insert.length;
		ta.setSelectionRange(caret, caret);
		ta.focus();
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		mentionBox.hidden = true;
		mentionAt = null;
	});
	$("[data-mention]", root).addEventListener("pointerdown", (e) => e.preventDefault());
	$("[data-mention]", root).addEventListener("click", () => {
		const ta = textareas()[active];
		const pos = ta.selectionStart ?? ta.value.length;
		const before = ta.value.slice(0, pos);
		const insert = (before && !/\s$/.test(before) ? " " : "") + "@";
		ta.setRangeText(insert, pos, ta.selectionEnd ?? pos, "end");
		ta.focus();
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});

	// ---- posting as another account (new posts only)
	$("[data-as]", root).addEventListener("click", async () => {
		if (!canSwitch || sending) return;
		const list = accounts();
		const pick = await actionSheet(
			list.map((a) => ({ label: `@${a.user.screen_name} · ${a.instance}${a.key === account.key ? "  ✓" : ""}`, value: a.key })),
			{ title: "Post as" },
		);
		const next = pick && list.find((a) => a.key === pick);
		if (!next || next.key === account.key) return;
		if (parts.some((p) => p.media.length)) toast("Photos and videos were uploaded to the other instance; add them again", { error: true });
		saveDraft();
		account = next;
		api = apiFor(next);
		parts = parts.map((p) => ({ text: p.text, media: [] }));
		renderAs();
		renderParts();
		textareas()[active]?.focus();
	});

	// ---- cancel and send
	$("[data-cancel]", root).onclick = async () => {
		const hasContent = parts.some((p) => p.text.trim() || p.media.length);
		if (!hasContent) {
			discard = true;
			return s.close();
		}
		if (!fresh) {
			const ok = await actionSheet([{ label: "Discard", danger: true, value: true }], { title: replyTo ? "Discard this reply?" : "Discard this post?" });
			if (!ok) return;
			discard = true;
			return s.close();
		}
		const choice = await actionSheet([
			{ label: "Delete", danger: true, value: "delete" },
			{ label: "Save draft", value: "save" },
		]);
		if (!choice) return;
		discard = choice === "delete";
		s.close();
	};

	send.onclick = async () => {
		if (send.disabled) return;
		sending = true;
		mentionBox.hidden = true;
		update();
		send.innerHTML = `<span class="mini-spin"></span>`;
		haptic(10);
		const total = parts.length + postedCount;
		try {
			while (parts.length) {
				const p = parts[0];
				const post = await api.createPost({
					text: p.text,
					...(parent ? { reply_to: parent } : {}),
					...(!firstPost && quote ? { quote: quote.id } : {}),
					...(p.media.length ? { media_ids: p.media.map((m) => m.id), sensitive } : {}),
				});
				firstPost ??= post;
				parent = post.id;
				// a posted part leaves the composer, so a failure later only retries the rest
				parts.shift();
				postedCount++;
			}
			sending = "done";
			clearDraft();
			s.close();
			if (account.key === ctx.account.key) ctx.posted?.(firstPost, { replyTo });
			const as = account.key === ctx.account.key ? "" : ` as @${account.user.screen_name}`;
			toast(replyTo ? `Your reply was sent${as}` : total > 1 ? `Your thread was sent${as}` : `Your post was sent${as}`);
		} catch (err) {
			sending = false;
			send.textContent = replyTo ? "Reply" : "Post";
			// the instance told us its real limit: remember it for this account
			const limit = /limited to ([\d,.\s]+) characters/i.exec(err.message);
			if (limit) {
				try {
					localStorage.setItem(limitKey(account.key), String(Number(limit[1].replace(/\D/g, ""))));
				} catch {}
			}
			active = 0;
			renderParts();
			toast(err.message, { error: true });
		}
	};

	renderAs();
	renderParts();
	// focus now, inside the tap that opened the composer: iOS only raises the
	// keyboard for focus that happens during a user gesture
	const ta = textareas()[active];
	ta?.focus({ preventScroll: true });
	ta?.setSelectionRange(ta.value.length, ta.value.length);
}
