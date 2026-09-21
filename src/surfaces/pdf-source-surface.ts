/**
 * Experimental PDF-in-Canvas surface support.
 *
 * Canvas has no public plugin API, so this intentionally uses a very small
 * structural interface instead of importing Canvas Kit's private types. The
 * goal of Phase 1 is modest: detect native PDF file nodes, give the embedded
 * PDF viewer a real internal scroll boundary, and keep those gestures from
 * being interpreted as Canvas pan/drag gestures.
 *
 * The class is designed so Jot's normalized page-coordinate ink engine can be
 * attached later without replacing this source-surface layer.
 */

interface CanvasNodeLike {
	nodeEl?: HTMLElement;
	getData?: () => Record<string, unknown>;
	unknownData?: Record<string, unknown>;
}

export interface CanvasSurfaceHost {
	wrapperEl: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
}

const SOURCE_CLASS = "jot-canvas-pdf-source";
const SCROLL_HOST_CLASS = "jot-canvas-pdf-scroll-host";
const BOUND_ATTR = "data-jot-canvas-pdf-bound";

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
	// Obsidian's PDF DOM has changed across releases. Current builds expose
	// .pdf-viewer-container; older builds commonly use .pdf-scroll-container.
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

export class PdfSourceSurfaceManager {
	private observers = new Map<CanvasSurfaceHost, MutationObserver>();
	private scheduled = new WeakSet<CanvasSurfaceHost>();

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
	}

	destroy(): void {
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
	}

	refresh(canvas: CanvasSurfaceHost): number {
		let count = 0;
		for (const node of canvas.nodes?.values() ?? []) {
			if (this.upgradeNode(node)) count += 1;
		}
		return count;
	}

	private scheduleRefresh(canvas: CanvasSurfaceHost): void {
		if (this.scheduled.has(canvas)) return;
		this.scheduled.add(canvas);
		window.requestAnimationFrame(() => {
			this.scheduled.delete(canvas);
			this.refresh(canvas);
		});
	}

	private upgradeNode(node: CanvasNodeLike): boolean {
		const nodeEl = node.nodeEl;
		const pdfPath = pdfPathForNode(node);
		if (!nodeEl || !pdfPath) return false;

		nodeEl.classList.add(SOURCE_CLASS);
		nodeEl.dataset.jotCanvasSourcePath = pdfPath;

		const scrollHost = findScrollHost(nodeEl);
		if (!scrollHost) return true;
		scrollHost.classList.add(SCROLL_HOST_CLASS);
		if (scrollHost.getAttribute(BOUND_ATTR) === "1") return true;
		scrollHost.setAttribute(BOUND_ATTR, "1");

		// Wheel scroll should stay inside the document until the document reaches
		// an edge. Ctrl/cmd+wheel is deliberately left alone for Canvas zoom.
		scrollHost.addEventListener(
			"wheel",
			(e) => {
				if (canConsumeWheel(scrollHost, e)) e.stopPropagation();
			},
			{ capture: false, passive: true }
		);

		// Let the PDF and its child controls receive the event first, then stop the
		// bubble before Canvas can reinterpret it as a node drag/pan. Do not use
		// capture here: a capture-phase stop on this ancestor can prevent PDF page
		// controls or a future Jot overlay from seeing the pointer at all.
		// We also do not preventDefault(), so native document scrolling remains live.
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
			scrollHost.addEventListener(type, (e) => e.stopPropagation(), {
				capture: true,
				passive: true,
			});
		}
		return true;
	}
}
