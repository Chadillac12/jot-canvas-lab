import type { DataAdapter } from "obsidian";

export type JotTool = "pen" | "highlighter";
export interface JotPoint { x: number; y: number; pressure: number; }
export interface JotStroke { points: JotPoint[]; color: string; width: number; tool: JotTool; }
interface JotPayload { version: number; pages: Record<string, JotStroke[]>; }

const JOT_VERSION = 2;
const JOT_SUFFIX = ".jot.json";
const SEP = "::";
const SAVE_DEBOUNCE_MS = 250;

export function pageKey(pdfPath: string, pageNumber: number): string {
	return `${pdfPath}${SEP}${pageNumber}`;
}

function pdfPathFromKey(key: string): string | null {
	const i = key.lastIndexOf(SEP);
	return i < 0 ? null : key.slice(0, i);
}

function migrateStroke(raw: Partial<JotStroke>): JotStroke {
	return {
		points: raw.points ?? [],
		color: raw.color ?? "#000000",
		width: raw.width ?? 0.0025,
		tool: raw.tool === "highlighter" ? "highlighter" : "pen",
	};
}

function parsePayload(text: string): JotPayload | null {
	try {
		const value = JSON.parse(text) as Partial<JotPayload>;
		if (typeof value.version !== "number" || !value.pages || typeof value.pages !== "object") return null;
		if (value.version !== 1 && value.version !== 2) return null;
		return value as JotPayload;
	} catch {
		return null;
	}
}

export function strokeIntersects(stroke: JotStroke, x: number, y: number, radius: number): boolean {
	const r2 = radius * radius;
	return stroke.points.some((p) => {
		const dx = p.x - x;
		const dy = p.y - y;
		return dx * dx + dy * dy < r2;
	});
}

export class JotInkStore {
	private strokes = new Map<string, JotStroke[]>();
	private loaded = new Set<string>();
	private loading = new Map<string, Promise<void>>();
	private saveTimers = new Map<string, number>();

	constructor(private adapter: DataAdapter, private onReload: () => void) {}

	isLoaded(pdfPath: string): boolean { return this.loaded.has(pdfPath); }
	forKey(key: string): JotStroke[] { return this.strokes.get(key) ?? []; }
	setForKey(key: string, strokes: JotStroke[]): void { this.strokes.set(key, strokes); }

	append(key: string, stroke: JotStroke): void {
		const list = this.strokes.get(key) ?? [];
		list.push(stroke);
		this.strokes.set(key, list);
	}

	ensureLoaded(pdfPath: string): Promise<void> {
		if (this.loaded.has(pdfPath)) return Promise.resolve();
		const existing = this.loading.get(pdfPath);
		if (existing) return existing;
		const promise = this.load(pdfPath).finally(() => this.loading.delete(pdfPath));
		this.loading.set(pdfPath, promise);
		return promise;
	}

	scheduleSave(pdfPath: string): void {
		const old = this.saveTimers.get(pdfPath);
		if (old !== undefined) window.clearTimeout(old);
		const id = window.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, SAVE_DEBOUNCE_MS);
		this.saveTimers.set(pdfPath, id);
	}

	destroy(): void {
		for (const id of this.saveTimers.values()) window.clearTimeout(id);
		this.saveTimers.clear();
	}

	private async load(pdfPath: string): Promise<void> {
		const sidecar = pdfPath + JOT_SUFFIX;
		for (const key of [...this.strokes.keys()]) {
			if (pdfPathFromKey(key) === pdfPath) this.strokes.delete(key);
		}
		try {
			if (await this.adapter.exists(sidecar)) {
				const parsed = parsePayload(await this.adapter.read(sidecar));
				if (parsed) {
					for (const [page, strokes] of Object.entries(parsed.pages)) {
						const n = Number.parseInt(page, 10);
						if (!Number.isFinite(n)) continue;
						this.strokes.set(pageKey(pdfPath, n), strokes.map(migrateStroke));
					}
				}
			}
		} catch (err) {
			console.error("[jot-canvas-lab] failed to load Jot sidecar", sidecar, err);
		}
		this.loaded.add(pdfPath);
		this.onReload();
	}

	private async save(pdfPath: string): Promise<void> {
		const pages: Record<string, JotStroke[]> = {};
		const prefix = pdfPath + SEP;
		for (const [key, strokes] of this.strokes) {
			if (!key.startsWith(prefix) || strokes.length === 0) continue;
			pages[key.slice(prefix.length)] = strokes;
		}
		const sidecar = pdfPath + JOT_SUFFIX;
		try {
			if (Object.keys(pages).length === 0) {
				if (await this.adapter.exists(sidecar)) await this.adapter.remove(sidecar);
				return;
			}
			const payload: JotPayload = { version: JOT_VERSION, pages };
			await this.adapter.write(sidecar, JSON.stringify(payload, null, 2));
		} catch (err) {
			console.error("[jot-canvas-lab] failed to save Jot sidecar", sidecar, err);
		}
	}
}
