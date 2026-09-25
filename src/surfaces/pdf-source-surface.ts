import type { DataAdapter } from "obsidian";
import {
	JotInkStore,
	type JotStroke,
	pageKey,
	strokeIntersects,
} from "../jot-bridge/jot-ink-store";
import { drawJotStroke } from "../jot-bridge/stroke-render";
import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from "../jot-bridge/canvas-surface";

interface CanvasNodeLike {
	nodeEl?: HTMLElement;
	text?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	startEditing?: () => void;
	getData?: () => Record<string, unknown>;
	setData?: (data: Record<string, unknown>) => void;
	moveAndResize?: (r: { x: number; y: number; width: number; height: number }) => void;
	unknownData?: Record<string, unknown>;
}

export interface CanvasSurfaceHost {
	wrapperEl: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
	createTextNode?: (opts: {
		pos: { x: number; y: number };
		size?: { width: number; height: number };
		text?: string;
		save?: boolean;
		focus?: boolean;
	}) => CanvasNodeLike | undefined;
	requestSave?: (pushHistory?: boolean) => void;
	requestPushHistory?: { run?: () => void };
	selectOnly?: (node: CanvasNodeLike) => void;
}

export interface PdfInkStyle {
	mode: "pen" | "highlighter" | "eraser";
	color: string;
	width: number;
}

const SOURCE_CLASS = "jot-canvas-pdf-source";
const SCROLL_HOST_CLASS = "jot-canvas-pdf-scroll-host";
const PAGE_CLASS = "jot-canvas-pdf-page";
const INK_OVERLAY_CLASS = "jot-canvas-pdf-ink";
const INK_KEY_ATTR = "data-jot-key";
const BOUND_ATTR = "data-jot-canvas-pdf-bound";
const ERASE_RADIUS = 0.02;

interface InkSession {
	canvas: CanvasSurfaceHost;
	pointerId: number;
	pdfPath: string;
	key: string;
	overlay: HTMLCanvasElement;
	style: PdfInkStyle;
	points: Array<{ x: number; y: number; pressure: number }>;
}

interface TouchScrollSession {
	canvas: CanvasSurfaceHost;
	pointerId: number;
	host: HTMLElement;
	lastX: number;
	lastY: number;
}

interface NativePageControlsState {
	canvas: CanvasSurfaceHost;
	node: CanvasNodeLike;
	nodeEl: HTMLElement;
	pdfPath: string;
	toolbar: HTMLElement;
	nativeInput: HTMLInputElement;
	controlsEl: HTMLElement;
	prevButton: HTMLButtonElement;
	nextButton: HTMLButtonElement;
	fitButton: HTMLButtonElement;
	linkButton: HTMLButtonElement;
	scrollHost: HTMLElement | null;
	onScroll: () => void;
	lastPage: number;
	totalPages: number;
}

interface PdfLinkedNote {
	sourceType: "pdf";
	sourcePath: string;
	sourceNodeId: string;
	page: number;
	pinned: boolean;
	expandedWidth: number;
	expandedHeight: number;
}

const NATIVE_CONTROLS_CLASS = "jot-canvas-pdf-native-page-controls";
const LINKED_NOTE_CLASS = "jot-canvas-linked-note";
const LINKED_NOTE_COLLAPSED_CLASS = "jot-canvas-linked-note-collapsed";
const LINKED_NOTE_HEADER_CLASS = "jot-canvas-linked-note-header";
const LINKED_NOTE_KEY = "jotCanvasPdfLink";
const LINKED_NOTE_COLLAPSED_WIDTH = 260;
const LINKED_NOTE_COLLAPSED_HEIGHT = 52;

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function pdfPathForNode(node: CanvasNodeLike): string | null {
	const data = node.getData?.() ?? {};
	const unknown = node.unknownData ?? {};
	const candidates = [
		asString(data.file),
		asString(data.path),
		asString(unknown.file),
		asString(unknown.path),
		node.nodeEl?.getAttribute("data-path"),
		node.nodeEl?.getAttribute("data-file"),
	];
	for (const candidate of candidates) {
		if (candidate?.toLowerCase().endsWith(".pdf")) return candidate;
	}
	return null;
}

function findScrollHost(nodeEl: HTMLElement): HTMLElement | null {
	return nodeEl.querySelector<HTMLElement>(
		".pdf-viewer-container, .pdf-scroll-container, .pdf-container"
	);
}

function canConsumeWheel(el: HTMLElement, e: WheelEvent): boolean {
	if (e.ctrlKey || e.metaKey) return false;
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	if (e.deltaY < 0 && el.scrollTop <= 0) return false;
	if (e.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return false;
	return true;
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

function nodeBox(node: CanvasNodeLike): { x: number; y: number; width: number; height: number } {
	const data = node.getData?.() ?? {};
	const pick = (value: unknown, fallback: number | undefined) => {
		const n = Number(value);
		return Number.isFinite(n) ? n : (fallback ?? 0);
	};
	return {
		x: pick(data.x, node.x),
		y: pick(data.y, node.y),
		width: pick(data.width, node.width),
		height: pick(data.height, node.height),
	};
}

function readLinkedNote(node: CanvasNodeLike): PdfLinkedNote | null {
	for (const data of [node.getData?.(), node.unknownData]) {
		const raw = data?.[LINKED_NOTE_KEY];
		if (!raw || typeof raw !== "object") continue;
		const value = raw as Record<string, unknown>;
		if (value.sourceType !== "pdf") continue;
		const sourcePath = typeof value.sourcePath === "string" ? value.sourcePath : "";
		const sourceNodeId = typeof value.sourceNodeId === "string" ? value.sourceNodeId : "";
		const page = Number(value.page);
		const expandedWidth = Number(value.expandedWidth);
		const expandedHeight = Number(value.expandedHeight);
		if (!sourcePath || !sourceNodeId || !Number.isFinite(page) || page < 1) continue;
		return {
			sourceType: "pdf",
			sourcePath,
			sourceNodeId,
			page: Math.max(1, Math.round(page)),
			pinned: value.pinned === true,
			expandedWidth: Number.isFinite(expandedWidth) && expandedWidth > 0 ? expandedWidth : 320,
			expandedHeight: Number.isFinite(expandedHeight) && expandedHeight > 0 ? expandedHeight : 180,
		};
	}
	return null;
}

function sourceLabel(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").pop() || path;
}

export class PdfSourceSurfaceManager {
	private observers = new Map<CanvasSurfaceHost, MutationObserver>();
	private scheduled = new WeakSet<CanvasSurfaceHost>();
	private pageResizeObservers = new Map<HTMLElement, ResizeObserver>();
	private nodeResizeObservers = new Map<HTMLElement, ResizeObserver>();
	private pendingNodeResize = new WeakSet<HTMLElement>();
	private pageIntersectionObservers = new Map<HTMLElement, IntersectionObserver>();
	private pageRegistrations = new WeakMap<HTMLElement, { pdfPath: string; pageNumber: number }>();
	private nativePageControls = new Map<HTMLElement, NativePageControlsState>();
	private ink: JotInkStore;
	private inkSession: InkSession | null = null;
	private touchSession: TouchScrollSession | null = null;

	constructor(adapter: DataAdapter) {
		this.ink = new JotInkStore(adapter, () => this.redrawAll());
	}

	attach(canvas: CanvasSurfaceHost): void {
		if (this.observers.has(canvas)) {
			this.refresh(canvas);
			return;
		}
		this.refresh(canvas);
		const observer = new MutationObserver(() => this.scheduleRefresh(canvas));
		observer.observe(canvas.wrapperEl, { childList: true, subtree: true });
		this.observers.set(canvas, observer);
	}

	detach(canvas: CanvasSurfaceHost): void {
		this.observers.get(canvas)?.disconnect();
		this.observers.delete(canvas);
		this.cancelInteraction(canvas);
		for (const nodeEl of Array.from(this.nativePageControls.keys())) {
			if (canvas.wrapperEl.contains(nodeEl)) this.destroyNativePageControls(nodeEl);
		}
	}

	destroy(): void {
		for (const observer of this.observers.values()) observer.disconnect();
		for (const observer of this.pageResizeObservers.values()) observer.disconnect();
		for (const observer of this.nodeResizeObservers.values()) observer.disconnect();
		for (const observer of this.pageIntersectionObservers.values()) observer.disconnect();
		for (const nodeEl of Array.from(this.nativePageControls.keys())) {
			this.destroyNativePageControls(nodeEl);
		}
		this.observers.clear();
		this.pageResizeObservers.clear();
		this.nodeResizeObservers.clear();
		this.pageIntersectionObservers.clear();
		this.ink.destroy();
		this.inkSession = null;
		this.touchSession = null;
	}

	refresh(canvas: CanvasSurfaceHost): number {
		let count = 0;
		for (const [nodeId, node] of canvas.nodes?.entries() ?? []) {
			if (this.upgradeNode(canvas, node)) count += 1;
			this.upgradeLinkedNote(canvas, nodeId, node);
		}
		return count;
	}

	/** Claim a pointer only when an active drawing tool actually hits a loaded PDF page. */
	beginInk(canvas: CanvasSurfaceHost, e: PointerEvent, style: PdfInkStyle): boolean {
		if (style.mode !== "eraser" && e.pointerType === "touch") return false;
		const hit = this.findPageHit(canvas, e.clientX, e.clientY);
		if (!hit || !this.ink.isLoaded(hit.pdfPath)) return false;
		const point = this.normalizedPoint(hit.page, e);
		this.inkSession = {
			canvas,
			pointerId: e.pointerId,
			pdfPath: hit.pdfPath,
			key: pageKey(hit.pdfPath, hit.pageNumber),
			overlay: hit.overlay,
			style,
			points: [point],
		};
		if (style.mode === "eraser") this.eraseAt(this.inkSession, point.x, point.y);
		else this.redrawOverlay(hit.overlay, this.previewStroke(this.inkSession));
		return true;
	}

	moveInk(canvas: CanvasSurfaceHost, e: PointerEvent): boolean {
		const session = this.inkSession;
		if (!session || session.canvas !== canvas || session.pointerId !== e.pointerId) return false;
		const page = session.overlay.closest<HTMLElement>(".page");
		if (!page) return false;
		const coalesced =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const events = coalesced.length > 0 ? coalesced : [e];
		for (const ev of events) {
			const p = this.normalizedPoint(page, ev);
			if (session.style.mode === "eraser") this.eraseAt(session, p.x, p.y);
			else session.points.push(p);
		}
		if (session.style.mode !== "eraser") {
			this.redrawOverlay(session.overlay, this.previewStroke(session));
		}
		return true;
	}

	endInk(canvas: CanvasSurfaceHost, e: PointerEvent): boolean {
		const session = this.inkSession;
		if (!session || session.canvas !== canvas || session.pointerId !== e.pointerId) return false;
		if (session.style.mode !== "eraser" && session.points.length > 1) {
			this.ink.append(session.key, this.previewStroke(session));
			this.ink.scheduleSave(session.pdfPath);
		}
		this.inkSession = null;
		this.redrawOverlay(session.overlay);
		return true;
	}

	/** Claim one-finger internal PDF scrolling only while the drawing overlay owns the gesture. */
	beginTouchScroll(canvas: CanvasSurfaceHost, e: PointerEvent): boolean {
		if (e.pointerType !== "touch") return false;
		const hit = this.findPdfNodeHit(canvas, e.clientX, e.clientY);
		if (!hit) return false;
		const host = findScrollHost(hit.nodeEl);
		if (!host || host.scrollHeight <= host.clientHeight + 1) return false;
		this.touchSession = {
			canvas,
			pointerId: e.pointerId,
			host,
			lastX: e.clientX,
			lastY: e.clientY,
		};
		return true;
	}

	moveTouchScroll(canvas: CanvasSurfaceHost, e: PointerEvent): boolean {
		const session = this.touchSession;
		if (!session || session.canvas !== canvas || session.pointerId !== e.pointerId) return false;
		const dx = e.clientX - session.lastX;
		const dy = e.clientY - session.lastY;
		session.lastX = e.clientX;
		session.lastY = e.clientY;
		session.host.scrollLeft -= dx;
		session.host.scrollTop -= dy;
		return true;
	}

	endTouchScroll(canvas: CanvasSurfaceHost, e: PointerEvent): boolean {
		const session = this.touchSession;
		if (!session || session.canvas !== canvas || session.pointerId !== e.pointerId) return false;
		this.touchSession = null;
		return true;
	}

	cancelInteraction(canvas: CanvasSurfaceHost): void {
		if (this.inkSession?.canvas === canvas) {
			const overlay = this.inkSession.overlay;
			this.inkSession = null;
			this.redrawOverlay(overlay);
		}
		if (this.touchSession?.canvas === canvas) this.touchSession = null;
	}

	private scheduleRefresh(canvas: CanvasSurfaceHost): void {
		if (this.scheduled.has(canvas)) return;
		this.scheduled.add(canvas);
		window.requestAnimationFrame(() => {
			this.scheduled.delete(canvas);
			this.refresh(canvas);
		});
	}

	private upgradeNode(canvas: CanvasSurfaceHost, node: CanvasNodeLike): boolean {
		const nodeEl = node.nodeEl;
		const pdfPath = pdfPathForNode(node);
		if (!nodeEl || !pdfPath) return false;

		nodeEl.classList.add(SOURCE_CLASS);
		nodeEl.dataset.jotCanvasSourcePath = pdfPath;
		this.observePdfNodeResize(nodeEl);
		if (!this.ink.isLoaded(pdfPath)) {
			void this.ink.ensureLoaded(pdfPath).then(() => this.scheduleRefresh(canvas));
		}

		const scrollHost = findScrollHost(nodeEl);
		if (scrollHost) {
			scrollHost.classList.add(SCROLL_HOST_CLASS);
			this.bindScrollBoundary(scrollHost);
			this.upgradePages(nodeEl, pdfPath, scrollHost);
		}
		this.ensureNativePageControls(canvas, node, nodeEl, pdfPath, scrollHost);
		return true;
	}

	private ensureNativePageControls(
		canvas: CanvasSurfaceHost,
		node: CanvasNodeLike,
		nodeEl: HTMLElement,
		pdfPath: string,
		scrollHost: HTMLElement | null
	): void {
		const toolbar = nodeEl.querySelector<HTMLElement>(".pdf-toolbar");
		const nativeInput =
			toolbar?.querySelector<HTMLInputElement>('input[type="number"]') ??
			toolbar?.querySelector<HTMLInputElement>("input");
		if (!toolbar || !nativeInput) {
			this.destroyNativePageControls(nodeEl);
			return;
		}

		const existing = this.nativePageControls.get(nodeEl);
		if (
			existing &&
			existing.toolbar === toolbar &&
			existing.nativeInput === nativeInput &&
			existing.scrollHost === scrollHost
		) {
			existing.canvas = canvas;
			existing.node = node;
			existing.pdfPath = pdfPath;
			this.updateNativePageState(existing);
			return;
		}
		if (existing) this.destroyNativePageControls(nodeEl);

		nativeInput.classList.add("jot-canvas-pdf-native-page-input");

		const doc = nodeEl.ownerDocument;
		const controlsEl = doc.createElement("div");
		controlsEl.className = NATIVE_CONTROLS_CLASS;
		controlsEl.setAttribute("role", "group");
		controlsEl.setAttribute("aria-label", "PDF page navigation");

		const prevButton = doc.createElement("button");
		prevButton.type = "button";
		prevButton.className = "jot-canvas-pdf-native-page-button";
		prevButton.setAttribute("aria-label", "Previous PDF page");
		prevButton.textContent = "‹";

		const nextButton = doc.createElement("button");
		nextButton.type = "button";
		nextButton.className = "jot-canvas-pdf-native-page-button";
		nextButton.setAttribute("aria-label", "Next PDF page");
		nextButton.textContent = "›";

		const fitButton = doc.createElement("button");
		fitButton.type = "button";
		fitButton.className = "jot-canvas-pdf-native-page-button jot-canvas-pdf-fit-card-button";
		fitButton.setAttribute("aria-label", "Fit PDF card to current page");
		fitButton.setAttribute("title", "Fit card to page");
		fitButton.textContent = "Fit";

		const linkButton = doc.createElement("button");
		linkButton.type = "button";
		linkButton.className = "jot-canvas-pdf-native-page-button jot-canvas-pdf-link-note-button";
		linkButton.setAttribute("aria-label", "Create linked note for current PDF page");
		linkButton.setAttribute("title", "Create linked note");
		linkButton.textContent = "Note";

		controlsEl.append(prevButton, nextButton, fitButton, linkButton);
		toolbar.appendChild(controlsEl);

		const state: NativePageControlsState = {
			canvas,
			node,
			nodeEl,
			pdfPath,
			toolbar,
			nativeInput,
			controlsEl,
			prevButton,
			nextButton,
			fitButton,
			linkButton,
			scrollHost,
			onScroll: () => this.updateNativePageState(state),
			lastPage: this.readNativePage(nativeInput),
			totalPages: this.readTotalPages(nodeEl, nativeInput),
		};

		const stop = (e: Event) => {
			e.stopPropagation();
		};
		for (const type of ["pointerdown", "pointerup", "click"] as const) {
			controlsEl.addEventListener(type, stop);
		}

		prevButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.stepNativePage(state, -1);
		});
		nextButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.stepNativePage(state, 1);
		});
		fitButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.fitCardToCurrentPage(state);
		});
		linkButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.createLinkedNote(state);
		});

		nativeInput.addEventListener("input", state.onScroll);
		nativeInput.addEventListener("change", state.onScroll);
		scrollHost?.addEventListener("scroll", state.onScroll, { passive: true });

		this.nativePageControls.set(nodeEl, state);
		this.updateNativePageState(state);
	}

	private destroyNativePageControls(nodeEl: HTMLElement): void {
		const state = this.nativePageControls.get(nodeEl);
		if (!state) return;
		state.nativeInput.removeEventListener("input", state.onScroll);
		state.nativeInput.removeEventListener("change", state.onScroll);
		state.scrollHost?.removeEventListener("scroll", state.onScroll);
		state.nativeInput.classList.remove("jot-canvas-pdf-native-page-input");
		state.controlsEl.remove();
		this.nativePageControls.delete(nodeEl);
	}

	private readNativePage(input: HTMLInputElement): number {
		const value = Number.parseInt(input.value, 10);
		return Number.isFinite(value) && value > 0 ? value : 1;
	}

	private readTotalPages(nodeEl: HTMLElement, input: HTMLInputElement): number {
		const max = Number.parseInt(input.max, 10);
		if (Number.isFinite(max) && max > 0) return max;
		let highest = 0;
		for (const page of Array.from(
			nodeEl.querySelectorAll<HTMLElement>(".page[data-page-number]")
		)) {
			const n = Number.parseInt(page.getAttribute("data-page-number") ?? "", 10);
			if (Number.isFinite(n)) highest = Math.max(highest, n);
		}
		return highest;
	}

	private updateNativePageState(state: NativePageControlsState): void {
		if (!state.nodeEl.isConnected || !state.nativeInput.isConnected) return;
		const page = this.readNativePage(state.nativeInput);
		const totalPages = this.readTotalPages(state.nodeEl, state.nativeInput);
		const previous = state.lastPage;
		state.lastPage = page;
		state.totalPages = totalPages;
		state.prevButton.disabled = page <= 1;
		state.nextButton.disabled = totalPages > 0 && page >= totalPages;
		state.nodeEl.dataset.jotCanvasCurrentPage = String(page);
		if (totalPages > 0) state.nodeEl.dataset.jotCanvasTotalPages = String(totalPages);

		if (page !== previous) {
			const win = state.nodeEl.ownerDocument.defaultView ?? window;
			state.nodeEl.dispatchEvent(
				new win.CustomEvent("jot-canvas-pdf-page-change", {
					bubbles: true,
					composed: true,
					detail: { pdfPath: state.pdfPath, page, totalPages },
				})
			);
		}
		this.syncLinkedNotes(state.canvas);
	}

	private nodeIdFor(canvas: CanvasSurfaceHost, target: CanvasNodeLike): string | null {
		for (const [id, node] of canvas.nodes?.entries() ?? []) {
			if (node === target) return id;
		}
		return null;
	}

	private writeLinkedNote(
		canvas: CanvasSurfaceHost,
		node: CanvasNodeLike,
		link: PdfLinkedNote
	): void {
		const stamp = (data: Record<string, unknown>) => {
			data[LINKED_NOTE_KEY] = { ...link };
		};
		try {
			if (node.unknownData) stamp(node.unknownData);
			if (node.getData && node.setData) {
				const data = node.getData();
				stamp(data);
				node.setData(data);
			}
			canvas.requestSave?.(false);
		} catch (err) {
			console.warn("Jot Canvas Lab: couldn't persist linked PDF note", err);
		}
	}

	private createLinkedNote(state: NativePageControlsState): void {
		const canvas = state.canvas;
		const sourceNodeId = this.nodeIdFor(canvas, state.node);
		if (!sourceNodeId || !canvas.createTextNode) return;
		const page = this.readNativePage(state.nativeInput);
		const sourceBox = nodeBox(state.node);

		let sameSourceNotes = 0;
		for (const node of canvas.nodes?.values() ?? []) {
			const link = readLinkedNote(node);
			if (link?.sourceNodeId === sourceNodeId) sameSourceNotes += 1;
		}

		const width = 320;
		const height = 180;
		const created = canvas.createTextNode({
			pos: {
				x: sourceBox.x + sourceBox.width + 48,
				y: sourceBox.y + (sameSourceNotes % 4) * 52,
			},
			size: { width, height },
			text: "",
			save: true,
			focus: true,
		});
		if (!created) return;

		const link: PdfLinkedNote = {
			sourceType: "pdf",
			sourcePath: state.pdfPath,
			sourceNodeId,
			page,
			pinned: false,
			expandedWidth: width,
			expandedHeight: height,
		};
		this.writeLinkedNote(canvas, created, link);
		canvas.selectOnly?.(created);
		created.startEditing?.();
		canvas.requestPushHistory?.run?.();
		this.scheduleRefresh(canvas);
	}

	private findSourceState(
		canvas: CanvasSurfaceHost,
		link: PdfLinkedNote
	): NativePageControlsState | null {
		let pathFallback: NativePageControlsState | null = null;
		for (const state of this.nativePageControls.values()) {
			if (state.canvas !== canvas) continue;
			const id = this.nodeIdFor(canvas, state.node);
			if (id === link.sourceNodeId) return state;
			if (!pathFallback && state.pdfPath === link.sourcePath) pathFallback = state;
		}
		return pathFallback;
	}

	private upgradeLinkedNote(
		canvas: CanvasSurfaceHost,
		nodeId: string,
		node: CanvasNodeLike
	): void {
		const el = node.nodeEl;
		const link = readLinkedNote(node);
		if (!el || !link) {
			el?.classList.remove(LINKED_NOTE_CLASS, LINKED_NOTE_COLLAPSED_CLASS);
			el?.querySelector(`:scope > .${LINKED_NOTE_HEADER_CLASS}`)?.remove();
			return;
		}

		el.classList.add(LINKED_NOTE_CLASS);
		el.dataset.jotCanvasLinkedPage = String(link.page);
		el.dataset.jotCanvasLinkedSource = link.sourcePath;
		this.ensureLinkedNoteHeader(canvas, nodeId, node, el, link);
		this.syncLinkedNoteNode(canvas, node, el, link);
	}

	private ensureLinkedNoteHeader(
		canvas: CanvasSurfaceHost,
		nodeId: string,
		node: CanvasNodeLike,
		el: HTMLElement,
		link: PdfLinkedNote
	): void {
		let header = el.querySelector<HTMLElement>(`:scope > .${LINKED_NOTE_HEADER_CLASS}`);
		if (!header) {
			header = el.ownerDocument.createElement("div");
			header.className = LINKED_NOTE_HEADER_CLASS;

			const sourceButton = el.ownerDocument.createElement("button");
			sourceButton.type = "button";
			sourceButton.className = "jot-canvas-linked-note-source";
			sourceButton.setAttribute("aria-label", "Jump to linked PDF page");

			const pinButton = el.ownerDocument.createElement("button");
			pinButton.type = "button";
			pinButton.className = "jot-canvas-linked-note-pin";
			pinButton.setAttribute("aria-label", "Pin linked note open");

			header.append(sourceButton, pinButton);
			el.appendChild(header);

			const stop = (e: Event) => e.stopPropagation();
			header.addEventListener("pointerdown", stop);
			header.addEventListener("pointerup", stop);

			sourceButton.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const current = readLinkedNote(node);
				if (!current) return;
				const source = this.findSourceState(canvas, current);
				if (!source) return;
				this.commitNativePage(source, current.page);
				this.syncLinkedNotes(canvas);
			});

			pinButton.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const current = readLinkedNote(node);
				if (!current) return;
				const next = { ...current, pinned: !current.pinned };
				this.writeLinkedNote(canvas, node, next);
				this.syncLinkedNoteNode(canvas, node, el, next);
				canvas.requestPushHistory?.run?.();
			});
		}

		const sourceButton = header.querySelector<HTMLButtonElement>(".jot-canvas-linked-note-source");
		const pinButton = header.querySelector<HTMLButtonElement>(".jot-canvas-linked-note-pin");
		if (sourceButton) {
			sourceButton.textContent = `p.${link.page} · ${sourceLabel(link.sourcePath)}`;
			sourceButton.title = `Jump to ${sourceLabel(link.sourcePath)}, page ${link.page}`;
		}
		if (pinButton) {
			pinButton.textContent = link.pinned ? "📌" : "Pin";
			pinButton.classList.toggle("is-pinned", link.pinned);
			pinButton.setAttribute(
				"aria-label",
				link.pinned ? "Unpin linked note" : "Pin linked note open"
			);
		}
		el.dataset.jotCanvasLinkedNodeId = nodeId;
	}

	private syncLinkedNotes(canvas: CanvasSurfaceHost): void {
		for (const node of canvas.nodes?.values() ?? []) {
			const link = readLinkedNote(node);
			const el = node.nodeEl;
			if (!link || !el) continue;
			this.syncLinkedNoteNode(canvas, node, el, link);
		}
	}

	private syncLinkedNoteNode(
		canvas: CanvasSurfaceHost,
		node: CanvasNodeLike,
		el: HTMLElement,
		link: PdfLinkedNote
	): void {
		const source = this.findSourceState(canvas, link);
		// If the source PDF isn't mounted yet, keep the note expanded rather than
		// unexpectedly hiding content.
		const shouldExpand = !source || link.pinned || source.lastPage === link.page;
		const box = nodeBox(node);

		if (shouldExpand) {
			const wasCollapsed = el.classList.contains(LINKED_NOTE_COLLAPSED_CLASS);
			el.classList.remove(LINKED_NOTE_COLLAPSED_CLASS);
			if (wasCollapsed && node.moveAndResize) {
				node.moveAndResize({
					x: box.x,
					y: box.y,
					width: link.expandedWidth,
					height: link.expandedHeight,
				});
			} else if (
				!wasCollapsed &&
				(box.width > LINKED_NOTE_COLLAPSED_WIDTH + 2 ||
					box.height > LINKED_NOTE_COLLAPSED_HEIGHT + 2) &&
				(Math.abs(box.width - link.expandedWidth) > 1 ||
					Math.abs(box.height - link.expandedHeight) > 1)
			) {
				this.writeLinkedNote(canvas, node, {
					...link,
					expandedWidth: Math.max(180, box.width),
					expandedHeight: Math.max(100, box.height),
				});
			}
			return;
		}

		if (!el.classList.contains(LINKED_NOTE_COLLAPSED_CLASS)) {
			const expandedWidth =
				box.width > LINKED_NOTE_COLLAPSED_WIDTH + 2 ? box.width : link.expandedWidth;
			const expandedHeight =
				box.height > LINKED_NOTE_COLLAPSED_HEIGHT + 2 ? box.height : link.expandedHeight;
			const next = {
				...link,
				expandedWidth: Math.max(180, expandedWidth),
				expandedHeight: Math.max(100, expandedHeight),
			};
			this.writeLinkedNote(canvas, node, next);
			el.classList.add(LINKED_NOTE_COLLAPSED_CLASS);
			node.moveAndResize?.({
				x: box.x,
				y: box.y,
				width: Math.min(next.expandedWidth, LINKED_NOTE_COLLAPSED_WIDTH),
				height: LINKED_NOTE_COLLAPSED_HEIGHT,
			});
		}
	}

	private fitCardToCurrentPage(state: NativePageControlsState): void {
		const pageNumber = this.readNativePage(state.nativeInput);
		const page =
			state.nodeEl.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`) ??
			state.nodeEl.querySelector<HTMLElement>(".page");
		if (!page || !state.node.moveAndResize) return;

		const pageWidth = page.clientWidth || page.offsetWidth;
		const pageHeight = page.clientHeight || page.offsetHeight;
		if (pageWidth <= 0 || pageHeight <= 0) return;

		const data = state.node.getData?.() ?? {};
		const x = Number(data.x);
		const y = Number(data.y);
		const width = Number(data.width);
		const fallbackX = state.node.x ?? 0;
		const fallbackY = state.node.y ?? 0;
		const fallbackWidth = state.node.width ?? 0;
		const nodeWidth = Number.isFinite(width) && width > 0 ? width : fallbackWidth;
		if (nodeWidth <= 0) return;

		const nodeLocalWidth = state.nodeEl.clientWidth || pageWidth;
		const toolbarHeight = state.toolbar.offsetHeight || 0;
		const chromeHeight = Math.max(
			0,
			state.nodeEl.clientHeight -
				(state.scrollHost?.clientHeight ?? state.nodeEl.clientHeight)
		);
		const localChrome = Math.max(toolbarHeight, chromeHeight);
		const pageLocalWidth = Math.min(pageWidth, nodeLocalWidth);
		const pageHeightAtNodeWidth =
			(pageHeight / Math.max(1, pageLocalWidth)) * nodeWidth;

		// Small breathing room prevents the bottom page edge/scrollbar from being
		// clipped without leaving the large dead zone of an arbitrary card height.
		const targetHeight = Math.max(
			120,
			Math.round(pageHeightAtNodeWidth + localChrome + 12)
		);

		state.node.moveAndResize({
			x: Number.isFinite(x) ? x : fallbackX,
			y: Number.isFinite(y) ? y : fallbackY,
			width: nodeWidth,
			height: targetHeight,
		});
		this.schedulePdfNodeResize(state.nodeEl);
	}

	private stepNativePage(state: NativePageControlsState, delta: number): void {
		const current = this.readNativePage(state.nativeInput);
		const total = this.readTotalPages(state.nodeEl, state.nativeInput);
		const requested = Math.max(1, total > 0 ? Math.min(total, current + delta) : current + delta);
		this.commitNativePage(state, requested);
	}

	private commitNativePage(state: NativePageControlsState, page: number): void {
		const input = state.nativeInput;
		const win = state.nodeEl.ownerDocument.defaultView ?? window;
		const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
		if (descriptor?.set) descriptor.set.call(input, String(page));
		else input.value = String(page);

		// Drive the exact control Obsidian/PDF.js already owns instead of
		// scrolling PDF DOM ourselves. This preserves the viewer's zoom/layout.
		input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
		input.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
		const keyboardInit: KeyboardEventInit = {
			key: "Enter",
			code: "Enter",
			bubbles: true,
			cancelable: true,
			composed: true,
		};
		input.dispatchEvent(new win.KeyboardEvent("keydown", keyboardInit));
		input.dispatchEvent(new win.KeyboardEvent("keyup", keyboardInit));

		// Update button state immediately. Native scroll/input events will refine
		// the current page once PDF.js completes its own navigation.
		state.lastPage = page;
		state.prevButton.disabled = page <= 1;
		state.nextButton.disabled = state.totalPages > 0 && page >= state.totalPages;
		state.nodeEl.dataset.jotCanvasCurrentPage = String(page);
		this.syncLinkedNotes(state.canvas);
	}

	private observePdfNodeResize(nodeEl: HTMLElement): void {
		if (this.nodeResizeObservers.has(nodeEl)) return;
		const observer = new ResizeObserver(() => this.schedulePdfNodeResize(nodeEl));
		observer.observe(nodeEl);
		this.nodeResizeObservers.set(nodeEl, observer);
	}

	private schedulePdfNodeResize(nodeEl: HTMLElement): void {
		if (this.pendingNodeResize.has(nodeEl)) return;
		this.pendingNodeResize.add(nodeEl);
		const win = nodeEl.ownerDocument.defaultView ?? window;
		win.requestAnimationFrame(() => {
			this.pendingNodeResize.delete(nodeEl);
			if (!nodeEl.isConnected) return;
			this.syncPdfNodeLayout(nodeEl);
			// Obsidian/PDF.js uses viewport resize notifications to recompute
			// page-width / auto-scale layouts. Debounced to one notification/frame.
			win.dispatchEvent(new Event("resize"));
		});
	}

	private syncPdfNodeLayout(nodeEl: HTMLElement): void {
		const selectors = [
			".canvas-node-container",
			".canvas-node-content",
			".file-embed",
			".internal-embed",
			".pdf-embed",
			".pdf-container",
			".pdf-viewer-container",
			".pdf-scroll-container",
		];
		for (const selector of selectors) {
			for (const el of Array.from(nodeEl.querySelectorAll<HTMLElement>(selector))) {
				el.style.maxWidth = "100%";
				el.style.minWidth = "0";
			}
		}
	}

	private bindScrollBoundary(scrollHost: HTMLElement): void {
		if (scrollHost.getAttribute(BOUND_ATTR) === "1") return;
		scrollHost.setAttribute(BOUND_ATTR, "1");

		// Contain wheel scrolling only while the embedded PDF can actually consume
		// it. Pointer events intentionally remain untouched: native Canvas needs
		// pointerdown/move/up to select, drag, connect, and operate cards when a
		// Jot/Canvas Kit drawing overlay has not explicitly claimed the gesture.
		scrollHost.addEventListener(
			"wheel",
			(e) => {
				if (canConsumeWheel(scrollHost, e)) e.stopPropagation();
			},
			{ capture: false, passive: true }
		);
	}

	private upgradePages(nodeEl: HTMLElement, pdfPath: string, scrollHost: HTMLElement): void {
		const observer = this.intersectionObserverFor(scrollHost);
		const pages = Array.from(nodeEl.querySelectorAll(".page")) as HTMLElement[];
		for (const page of pages) {
			const raw = page.getAttribute("data-page-number");
			const pageNumber = raw ? Number.parseInt(raw, 10) : NaN;
			if (!Number.isFinite(pageNumber)) continue;
			page.classList.add(PAGE_CLASS);
			this.pageRegistrations.set(page, { pdfPath, pageNumber });
			if (observer) observer.observe(page);
			else this.activatePage(page);
		}
	}

	private intersectionObserverFor(scrollHost: HTMLElement): IntersectionObserver | null {
		const existing = this.pageIntersectionObservers.get(scrollHost);
		if (existing) return existing;
		const win = scrollHost.ownerDocument.defaultView ?? window;
		const Ctor = win.IntersectionObserver;
		if (typeof Ctor !== "function") return null;
		const observer = new Ctor(
			(entries) => {
				for (const entry of entries) {
					const page = entry.target as HTMLElement;
					if (entry.isIntersecting) this.activatePage(page);
					else this.deactivatePage(page);
				}
			},
			{ root: scrollHost, rootMargin: "1200px 0px", threshold: 0 }
		);
		this.pageIntersectionObservers.set(scrollHost, observer);
		return observer;
	}

	private activatePage(page: HTMLElement): void {
		const registration = this.pageRegistrations.get(page);
		if (!registration || !page.isConnected) return;
		const key = pageKey(registration.pdfPath, registration.pageNumber);
		let overlay = page.querySelector(`canvas.${INK_OVERLAY_CLASS}`) as HTMLCanvasElement | null;
		if (!overlay) {
			overlay = page.ownerDocument.createElement("canvas");
			overlay.className = INK_OVERLAY_CLASS;
			page.appendChild(overlay);
		}
		overlay.setAttribute(INK_KEY_ATTR, key);
		this.sizeOverlayToPage(overlay, page);
		this.observeActivePage(page);
		this.redrawOverlay(overlay);
	}

	private deactivatePage(page: HTMLElement): void {
		const resize = this.pageResizeObservers.get(page);
		if (resize) {
			resize.disconnect();
			this.pageResizeObservers.delete(page);
		}
		const overlay = page.querySelector(`canvas.${INK_OVERLAY_CLASS}`) as HTMLCanvasElement | null;
		if (!overlay) return;
		overlay.width = 0;
		overlay.height = 0;
		overlay.remove();
	}

	private observeActivePage(page: HTMLElement): void {
		if (this.pageResizeObservers.has(page)) return;
		const observer = new ResizeObserver(() => {
			const overlay = page.querySelector(`canvas.${INK_OVERLAY_CLASS}`) as HTMLCanvasElement | null;
			if (!overlay || !page.isConnected) return;
			this.sizeOverlayToPage(overlay, page);
			this.redrawOverlay(overlay);
		});
		observer.observe(page);
		this.pageResizeObservers.set(page, observer);
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): void {
		const rect = page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		// Obsidian Canvas zoom transforms the entire node. Keep the overlay's CSS
		// box in PAGE-LOCAL coordinates and only use the transformed rect to choose
		// backing-store density. Using rect.width as CSS width double-applies the
		// Canvas zoom and visibly shifts ink away from the Pencil.
		const localWidth = page.clientWidth || page.offsetWidth || rect.width;
		const localHeight = page.clientHeight || page.offsetHeight || rect.height;
		if (localWidth <= 0 || localHeight <= 0) return;

		const visualScaleX = rect.width / localWidth;
		const visualScaleY = rect.height / localHeight;
		const visualScale = Math.max(0.1, Math.max(visualScaleX, visualScaleY));
		const win = page.ownerDocument.defaultView ?? window;
		const requestedDpr = devicePixelRatioFor(win) * visualScale;
		const dpr = safeBackingStoreDpr(localWidth, localHeight, requestedDpr);

		applyBackingStoreSize(overlay, localWidth, localHeight, dpr);
		overlay.style.width = "100%";
		overlay.style.height = "100%";
	}

	private previewStroke(session: InkSession): JotStroke {
		return {
			points: session.points,
			color: session.style.color,
			width: session.style.width,
			tool: session.style.mode === "highlighter" ? "highlighter" : "pen",
		};
	}

	private eraseAt(session: InkSession, x: number, y: number): void {
		const before = this.ink.forKey(session.key);
		const after = before.filter((stroke) => !strokeIntersects(stroke, x, y, ERASE_RADIUS));
		if (after.length === before.length) return;
		this.ink.setForKey(session.key, after);
		this.ink.scheduleSave(session.pdfPath);
		this.redrawOverlay(session.overlay);
	}

	private normalizedPoint(page: HTMLElement, e: PointerEvent) {
		const rect = page.getBoundingClientRect();
		return {
			x: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
			y: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
			pressure: e.pressure > 0 ? e.pressure : 0.5,
		};
	}

	private redrawOverlay(overlay: HTMLCanvasElement, preview?: JotStroke): void {
		const ctx = overlay.getContext("2d");
		if (!ctx) return;
		const surface = readCanvasSurface(overlay);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		const key = overlay.getAttribute(INK_KEY_ATTR);
		if (key) {
			for (const stroke of this.ink.forKey(key)) drawJotStroke(ctx, stroke, surface);
		}
		if (preview) drawJotStroke(ctx, preview, surface);
	}

	private redrawAll(): void {
		for (const canvas of this.observers.keys()) {
			canvas.wrapperEl
				.querySelectorAll<HTMLCanvasElement>(`canvas.${INK_OVERLAY_CLASS}`)
				.forEach((overlay) => this.redrawOverlay(overlay));
		}
	}

	private findPdfNodeHit(canvas: CanvasSurfaceHost, x: number, y: number) {
		const doc = canvas.wrapperEl.ownerDocument;
		const stack = typeof doc.elementsFromPoint === "function" ? doc.elementsFromPoint(x, y) : [];
		const topCanvasNode = stack
			.map((el) => (el as HTMLElement).closest?.(".canvas-node") as HTMLElement | null)
			.find((el): el is HTMLElement => !!el);

		for (const node of canvas.nodes?.values() ?? []) {
			const nodeEl = node.nodeEl;
			const pdfPath = pdfPathForNode(node);
			if (!nodeEl || !pdfPath) continue;
			if (!containsPoint(nodeEl.getBoundingClientRect(), x, y)) continue;
			// If another Canvas node is visually above this PDF at the gesture
			// origin, that node owns the interaction. Do not scroll/ink the PDF
			// underneath it merely because their rectangles overlap.
			if (topCanvasNode && topCanvasNode !== nodeEl) continue;
			return { nodeEl, pdfPath };
		}
		return null;
	}

	private findPageHit(canvas: CanvasSurfaceHost, x: number, y: number) {
		const nodeHit = this.findPdfNodeHit(canvas, x, y);
		if (!nodeHit) return null;
		const pages = Array.from(nodeHit.nodeEl.querySelectorAll(".page")) as HTMLElement[];
		for (const page of pages) {
			if (!containsPoint(page.getBoundingClientRect(), x, y)) continue;
			const raw = page.getAttribute("data-page-number");
			const pageNumber = raw ? Number.parseInt(raw, 10) : NaN;
			if (!Number.isFinite(pageNumber)) continue;

			// Native PDF page jumps can replace/virtualize page DOM before the
			// IntersectionObserver has recreated Jot's overlay. Pencil-down is the
			// authoritative demand signal: register and activate this page now.
			this.pageRegistrations.set(page, {
				pdfPath: nodeHit.pdfPath,
				pageNumber,
			});
			let overlay = page.querySelector(
				`canvas.${INK_OVERLAY_CLASS}`
			) as HTMLCanvasElement | null;
			if (!overlay) {
				this.activatePage(page);
				overlay = page.querySelector(
					`canvas.${INK_OVERLAY_CLASS}`
				) as HTMLCanvasElement | null;
			}
			if (!overlay) continue;
			return { ...nodeHit, page, pageNumber, overlay };
		}
		return null;
	}
}
