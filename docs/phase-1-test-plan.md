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


## Beta 4 — interaction ownership / native Canvas coexistence

This is a blocking gate before deeper Jot-core integration.

- [ ] With **Select** active, an embedded PDF card can be selected, moved, resized, and connected like a normal Canvas node.
- [ ] Obsidian's native bottom Canvas controls (card / note / media) are visible after upgrading from beta.3.
- [ ] Native Canvas controls can create cards/notes while Jot Canvas Lab remains enabled.
- [ ] Canvas Kit **Marker / Highlighter / Eraser** still write directly over the Canvas.
- [ ] Pencil over a PDF while a drawing tool is active writes to the PDF Jot sidecar rather than creating Canvas ink.
- [ ] Pencil outside a PDF while a drawing tool is active still creates Canvas Kit freehand ink.
- [ ] One-finger touch over a PDF can scroll the PDF when the drawing tool owns that gesture.
- [ ] Two-finger Canvas pan/zoom still works with drawing tools active.
- [ ] Wheel/trackpad scrolling is contained by the PDF only while the PDF can actually scroll; boundary wheel events return to Canvas.
- [ ] Switching back to Select leaves no full-screen drawing overlay intercepting native Canvas input.

### Ownership rule

**Do not stop native Canvas pointer propagation merely because the event happened inside a PDF card.**
Canvas Lab may consume/prevent an event only after an active tool/session explicitly claims that interaction.


## Beta 5 — Pencil capture + PDF card resize

- [ ] Marker draws on empty Canvas space with Apple Pencil.
- [ ] Highlighter draws on empty Canvas space with Apple Pencil.
- [ ] Tape and eraser still receive Pencil input.
- [ ] Pencil over an embedded PDF routes into Jot PDF ink.
- [ ] Switching to Select releases Pencil capture and native Canvas manipulation still works.
- [ ] Resizing a PDF Canvas node changes the embedded PDF viewport width and height, not just the outer card frame.
- [ ] PDF internal scrolling still works after repeated node resize.
- [ ] Canvas pan/zoom still works.


## Beta 6 — routed Pencil move sampling + PDF hit ownership

- [ ] Marker stroke extends continuously after the initial Pencil dot.
- [ ] Highlighter stroke extends continuously after the initial Pencil dot.
- [ ] PDF/Jot stroke extends continuously and persists after Pencil-up.
- [ ] Routed synthetic Pencil moves fall back to the current event when `getCoalescedEvents()` is empty.
- [ ] A PDF card underneath another Canvas card does not steal a drag/scroll gesture from the top card.
- [ ] PDF scrolling still begins normally when the PDF itself is the topmost node under the finger.
- [ ] Select/card/native Canvas coexistence remains intact.
- [ ] PDF card resize improvements remain intact.


## Beta 7 — PDF ink coordinate space + explicit card move grip

- [ ] PDF marker lands directly beneath the Pencil at multiple Canvas zoom levels.
- [ ] PDF highlighter lands directly beneath the Pencil at multiple Canvas zoom levels.
- [ ] PDF ink remains aligned after resizing the PDF card.
- [ ] PDF ink remains aligned after Canvas pan/zoom.
- [ ] Every non-group, non-ink card exposes a small grip handle.
- [ ] Dragging the grip moves a plain note card without entering edit mode.
- [ ] Dragging the grip moves a PDF card without scrolling the PDF.
- [ ] Dragging another card across/over a PDF does not scroll the PDF underneath.
- [ ] Tapping a card body still performs its normal edit/open behavior.


## Beta 8 — iPad drag-grip polish

- [ ] Drag grip is easy to acquire with a finger without precise aiming.
- [ ] Grip sits partly outside the top edge of the card and remains visible.
- [ ] Accent-color grip is visually distinct from card content.
- [ ] Dragging the grip still moves plain notes, PDFs, and image/file cards.
- [ ] Card body taps still preserve normal edit/open behavior.
- [ ] PDF ink alignment and resize behavior remain unchanged from beta.7.


## Beta 9 — card-local handwriting

- [ ] Marker stroke that starts inside a normal card moves with that card.
- [ ] Highlighter stroke that starts inside a normal card moves with that card.
- [ ] Marker/highlighter stroke that starts on empty Canvas remains independent world ink.
- [ ] PDF ink remains page-local and unchanged.
- [ ] Moving a card with the explicit grip moves attached handwriting live.
- [ ] Close and reopen the Canvas; attached handwriting still follows its card.
- [ ] Resizing a card does not stretch handwriting; attached ink preserves its own size and local offset.
- [ ] Moving a card with native Canvas controls eventually re-syncs attached handwriting.


## Beta 10 — attached ink selection stacking

- [ ] Attached handwriting remains visible while its parent card is selected.
- [ ] Attached handwriting remains visible while its parent card is focused/editable.
- [ ] Deselecting the card does not change ink position or appearance.
- [ ] Attached ink does not intercept taps, selection, editing, or drag-grip gestures.
- [ ] Moving the card still moves attached handwriting.
- [ ] Blank-Canvas ink and PDF ink behavior remain unchanged.


## Beta 11 — restore live card drawing

- [ ] Marker draws visibly on a normal card from the first Pencil movement.
- [ ] Highlighter draws visibly on a normal card from the first Pencil movement.
- [ ] Finished card-local ink remains attached and moves with the card.
- [ ] Selecting the parent card after drawing keeps attached ink visible.
- [ ] PDF ink remains unchanged.
- [ ] Blank-Canvas ink remains unchanged.


## Beta 12 — attached ink visible at rest

- [ ] Card-local handwriting is visible while the parent card is unselected.
- [ ] Selecting/focusing the parent card does not hide or reveal the handwriting; it stays continuously visible.
- [ ] Attached handwriting remains pointer-transparent.
- [ ] Moving the card still moves attached handwriting.
- [ ] Blank-Canvas ink and PDF ink remain unchanged.
