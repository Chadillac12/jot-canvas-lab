# Phase 1 manual test plan

The first prototype is intentionally a feasibility test for Obsidian's native PDF viewer inside Canvas.

## Desktop smoke test

1. Install the branch build as `jot-canvas-lab`.
2. Open a Canvas containing a PDF file node.
3. Run **Jot Canvas Lab: Refresh PDF source surfaces on active canvas**.
4. Confirm the node shows the small **PDF surface** badge.
5. Resize the Canvas node taller and shorter.
6. Place the pointer over the PDF and scroll.
7. Confirm the PDF consumes vertical wheel scrolling while more document content remains.
8. At the top/bottom edge, confirm normal Canvas behavior can resume.
9. Confirm Ctrl/Cmd + wheel is not intercepted by the PDF source-surface handler.
10. Confirm PDF controls still respond to clicks.

## iPad feasibility test

1. Open the same Canvas on iPad.
2. Confirm the PDF surface badge appears.
3. Drag one finger vertically inside the PDF.
4. Confirm the document scrolls without dragging the Canvas node.
5. Verify taps on PDF controls still work.
6. Resize/reopen the Canvas and confirm the behavior survives DOM re-rendering.
7. Note what two-finger gestures do. Phase 1 prioritizes internal PDF scrolling; Canvas-vs-document two-finger routing will be refined after this test.

## What decides Phase 2

Proceed with the native viewer if all of these are true:

- multiple PDF pages are present and continuously reachable;
- page DOM/canvas elements stay identifiable after scrolling and resizing;
- iPad scrolling is stable;
- Canvas does not repeatedly rebuild/reload the PDF surface.

If the native embed only materializes a fixed page, aggressively re-renders, or cannot isolate gestures reliably, keep the source-surface abstraction but replace the renderer with PDF.js before attaching Jot ink.
