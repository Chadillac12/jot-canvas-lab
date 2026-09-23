export interface CanvasSurface { width: number; height: number; dpr: number; }
const MAX_DIMENSION = 4096;
const MAX_AREA = 16_777_216;

export function devicePixelRatioFor(host: { devicePixelRatio?: number }): number {
	const v = host.devicePixelRatio;
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}
export function safeBackingStoreDpr(cssWidth: number, cssHeight: number, requestedDpr: number): number {
	if (!(cssWidth > 0) || !(cssHeight > 0)) return requestedDpr || 1;
	const dpr = requestedDpr > 0 ? requestedDpr : 1;
	return Math.max(0.1, Math.min(dpr, MAX_DIMENSION / cssWidth, MAX_DIMENSION / cssHeight, Math.sqrt(MAX_AREA / (cssWidth * cssHeight))));
}
export function applyBackingStoreSize(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, dpr: number): void {
	const w = Math.max(1, Math.round(cssWidth * dpr)), h = Math.max(1, Math.round(cssHeight * dpr));
	if (canvas.width !== w) canvas.width = w;
	if (canvas.height !== h) canvas.height = h;
}
export function readCanvasSurface(canvas: HTMLCanvasElement): CanvasSurface {
	// Canvas source surfaces can live beneath Obsidian Canvas transforms.
	// clientWidth/clientHeight are LOCAL layout units; getBoundingClientRect()
	// is transformed screen space. Ink rendering must use local units so the
	// ancestor Canvas zoom is applied exactly once.
	const styleW =
		canvas.style.width.endsWith("px") ? Number.parseFloat(canvas.style.width) : Number.NaN;
	const styleH =
		canvas.style.height.endsWith("px") ? Number.parseFloat(canvas.style.height) : Number.NaN;
	const rect = canvas.getBoundingClientRect();
	const width =
		canvas.clientWidth > 0
			? canvas.clientWidth
			: Number.isFinite(styleW) && styleW > 0
				? styleW
				: rect.width > 0
					? rect.width
					: canvas.width;
	const height =
		canvas.clientHeight > 0
			? canvas.clientHeight
			: Number.isFinite(styleH) && styleH > 0
				? styleH
				: rect.height > 0
					? rect.height
					: canvas.height;
	const dpr = width > 0 ? canvas.width / width : 1;
	return { width, height, dpr: dpr > 0 ? dpr : 1 };
}
