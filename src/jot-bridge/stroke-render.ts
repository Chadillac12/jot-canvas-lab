import type { JotPoint, JotStroke } from "./jot-ink-store";

export interface CanvasSize { width: number; height: number; dpr?: number; }

const HIGHLIGHTER_ALPHA = 0.35;
const HIGHLIGHTER_WIDTH_FACTOR = 4;
const PRESSURE_MIN_FACTOR = 0.5;
const PRESSURE_MAX_FACTOR = 1.8;
const SMOOTH_SUBDIVISIONS = 6;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const pressureFactor = (p: number) => PRESSURE_MIN_FACTOR + (PRESSURE_MAX_FACTOR - PRESSURE_MIN_FACTOR) * clamp01(p);
const denorm = (p: JotPoint, c: CanvasSize) => ({ x: p.x * c.width, y: p.y * c.height });

function quadraticAt(a: JotPoint, b: JotPoint, c: JotPoint, t: number): JotPoint {
	const i = 1 - t;
	return {
		x: i * i * a.x + 2 * i * t * b.x + t * t * c.x,
		y: i * i * a.y + 2 * i * t * b.y + t * t * c.y,
		pressure: i * a.pressure + t * c.pressure,
	};
}

function forSmoothSegments(points: JotPoint[], emit: (a: JotPoint, b: JotPoint) => void): void {
	if (points.length < 2) return;
	if (points.length === 2) { emit(points[0], points[1]); return; }
	const midpoint = (a: JotPoint, b: JotPoint): JotPoint => ({
		x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, pressure: (a.pressure + b.pressure) / 2,
	});
	let prev = midpoint(points[0], points[1]);
	emit(points[0], prev);
	for (let i = 1; i < points.length - 1; i++) {
		const control = points[i];
		const next = midpoint(control, points[i + 1]);
		let last = prev;
		for (let s = 1; s <= SMOOTH_SUBDIVISIONS; s++) {
			const p = quadraticAt(prev, control, next, s / SMOOTH_SUBDIVISIONS);
			emit(last, p);
			last = p;
		}
		prev = next;
	}
	emit(prev, points[points.length - 1]);
}

export function drawJotStroke(ctx: CanvasRenderingContext2D, stroke: JotStroke, canvas: CanvasSize): void {
	const dpr = canvas.dpr ?? 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	if (stroke.tool === "highlighter") {
		if (stroke.points.length < 2) return;
		ctx.save();
		ctx.lineWidth = stroke.width * HIGHLIGHTER_WIDTH_FACTOR * canvas.height;
		ctx.strokeStyle = stroke.color;
		ctx.lineCap = "butt";
		ctx.lineJoin = "round";
		ctx.globalAlpha = HIGHLIGHTER_ALPHA;
		ctx.beginPath();
		const first = denorm(stroke.points[0], canvas);
		ctx.moveTo(first.x, first.y);
		for (let i = 1; i < stroke.points.length; i++) {
			const p = denorm(stroke.points[i], canvas);
			ctx.lineTo(p.x, p.y);
		}
		ctx.stroke();
		ctx.restore();
		return;
	}
	forSmoothSegments(stroke.points, (a, b) => {
		ctx.lineWidth = stroke.width * pressureFactor((a.pressure + b.pressure) / 2) * canvas.height;
		ctx.strokeStyle = stroke.color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const p0 = denorm(a, canvas), p1 = denorm(b, canvas);
		ctx.beginPath();
		ctx.moveTo(p0.x, p0.y);
		ctx.lineTo(p1.x, p1.y);
		ctx.stroke();
	});
}
