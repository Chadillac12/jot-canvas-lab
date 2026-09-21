# Jot Canvas Lab architecture

Jot Canvas Lab is an experimental fork of Canvas Kit that explores **interactive source surfaces** inside Obsidian Canvas.

## Why a source surface?

A native Canvas file card is a useful container, but it treats an embedded PDF mostly like a card preview. For study and research workflows we want the source itself to remain interactive:

- scroll through the full PDF inside a bounded Canvas node;
- annotate PDF pages with Jot-compatible normalized coordinates;
- create notes anchored to a page/location;
- later extend the same anchor model to video timestamps and images.

The Canvas node owns **spatial layout**. The source surface owns **document navigation and interaction**. Jot owns **portable document annotations**.

## State ownership

| State | Owner |
| --- | --- |
| Canvas position, size, edges, groups | `.canvas` file |
| PDF scroll/view state | Canvas source-node metadata (future phase) |
| PDF ink | Jot `<pdf>.jot.json` sidecar |
| Source-to-note anchors | versioned source metadata / Jot sidecar (future phase) |

## Phase 1: native PDF source surface

Phase 1 deliberately keeps Obsidian's native PDF viewer. `PdfSourceSurfaceManager` detects Canvas nodes whose file data ends in `.pdf`, marks the node as a source surface, and establishes an internal scroll/gesture boundary.

This is a feasibility probe. Before adopting PDF.js we need to learn whether the native embedded viewer can reliably provide:

1. continuous multi-page scrolling;
2. predictable page DOM surfaces;
3. gesture isolation from Canvas pan/zoom;
4. stable behavior on iPad.

If any of these fail, the source-surface abstraction remains valid and the renderer can be replaced with PDF.js later.

## Phase 2: Jot ink adapter

Refactor Jot's PDF-specific overlay attachment behind a small page-surface contract:

```ts
interface AnnotatablePageSurface {
  sourcePath: string;
  pageNumber: number;
  element: HTMLElement;
  screenToNormalized(clientX: number, clientY: number): { x: number; y: number };
  normalizedToScreen(x: number, y: number): { x: number; y: number };
}
```

Both the normal Obsidian PDF view and a Canvas PDF source surface can implement this contract while sharing the same Jot sidecar and stroke model.

## Phase 3: anchored notes

Add anchors such as:

```json
{
  "type": "pdf-region",
  "source": "SYS579/Module 4.pdf",
  "page": 14,
  "x": 0.42,
  "y": 0.61,
  "target": "Notes/Expected Value.md"
}
```

Dragging from an anchor can create a Canvas note/card and edge. Activating the anchor returns the document to the exact source location.

## Phase 4: video surfaces

Reuse the same source/locator/anchor model with a timestamp locator instead of PDF page coordinates.
