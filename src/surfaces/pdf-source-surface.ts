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
	getData?: () => Record<string, unknown>;
	unknownData?: Record<string, unknown>;
}

export interface CanvasSurfaceHost {
	wrapperEl: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
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

export class PdfSourceSurfaceManager {
	private observers = new Map<CanvasSurfaceHost, MutationObserver>();
	private scheduled = new WeakSet<CanvasSurfaceHost>();
	private pageResizeObservers = new Map<HTMLElement, ResizeObserver>();
	private nodeResizeObservers = new Map<HTMLElement, ResizeObserver>();
	private pendingNodeResize = new WeakSet<HTMLElement>();
	private pageIntersectionObservers = new Map<HTMLElement, IntersectionObserver>();
	private pageRegistrations = new WeakMap<HTMLElement, { pdfPath: string; pageNumber: number }>();
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
	}

	destroy(): void {
		for (const observer of this.observers.values()) observer.disconnect();
		for (const observer of this.pageResizeObservers.values()) observer.disconnect();
		for (const observer of this.nodeResizeObservers.values()) observer.disconnect();
		for (const observer of this.pageIntersectionObservers.values()) observer.disconnect();
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
		for (const node of canvas.nodes?.values() ?? []) {
			if (this.upgradeNode(canvas, node)) count += 1;
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
		return true;
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
		const dpr = safeBackingStoreDpr(rect.width, rect.height, devicePixelRatioFor(window));
		applyBackingStoreSize(overlay, rect.width, rect.height, dpr);
		overlay.style.width = `${rect.width}px`;
		overlay.style.height = `${rect.height}px`;
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
			const overlay = page.querySelector(`canvas.${INK_OVERLAY_CLASS}`) as HTMLCanvasElement | null;
			if (!overlay) continue;
			return { ...nodeHit, page, pageNumber, overlay };
		}
		return null;
	}
}
