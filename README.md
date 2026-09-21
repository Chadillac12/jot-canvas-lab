# Jot Canvas Lab

**Experimental Obsidian plugin for turning Canvas cards into interactive source surfaces.**

This repository started from [Canvas Kit](https://github.com/yaye-work/canvas-kit) by yaye.work and is being used as a lab for combining Canvas Kit's spatial workflow with ideas from [Jot](https://github.com/Chadillac12/jot).

> This is a development lab, not a replacement for Jot or Canvas Kit yet.

## Goal

The first target workflow is:

1. place a PDF in an Obsidian Canvas;
2. scroll the complete document inside the Canvas node instead of treating the card as a fixed-page preview;
3. annotate pages with Jot-style normalized Apple Pencil ink;
4. create quick notes anchored to exact PDF locations;
5. later apply the same anchor model to video timestamps and images.

## Current prototype: Phase 1

The `feature/pdf-source-surface` work introduces a **PDF source surface** layer around native PDF Canvas nodes.

For now it:

- detects Canvas file nodes that reference PDFs;
- gives the native embedded PDF viewer an explicit internal scroll boundary;
- prevents PDF wheel/pointer gestures from leaking into Canvas drag/pan while the document can consume them;
- supports both newer `.pdf-viewer-container` and older `.pdf-scroll-container` PDF DOM variants;
- keeps the implementation isolated so Jot's annotation engine can be attached in the next phase.

Run the command **Jot Canvas Lab: Refresh PDF source surfaces on active canvas** if you want to force a rescan while testing.

## Architecture

See [docs/architecture.md](docs/architecture.md).

The central idea is to keep three responsibilities separate:

- **Canvas** owns spatial layout.
- **Source surfaces** own source navigation and interaction.
- **Jot** owns portable per-document annotation data.

## Install with BRAT (recommended for this lab)

This lab is published as a GitHub **pre-release** specifically for BRAT testing.

1. Install and enable **BRAT** in Obsidian.
2. Open **Settings → BRAT**.
3. Choose **Add Beta plugin**.
4. Paste this repository URL:

   `https://github.com/Chadillac12/jot-canvas-lab`

5. Choose the latest version when BRAT asks (currently `0.0.1-beta.1`).
6. Let BRAT install the release, then enable **Jot Canvas Lab** under **Community plugins**.

The plugin ID is `jot-canvas-lab`, so it installs separately from Canvas Kit. For the first PDF-surface test, disable regular Canvas Kit so its toolbar/input handlers do not compete with the lab fork.

## Development

```sh
npm install
npm run build
```

For manual testing, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/jot-canvas-lab/
```

The plugin ID is intentionally different from Canvas Kit so both can be installed side-by-side during development. Disable one if their toolbars conflict during testing.

## Upstream attribution

Canvas UI/tooling in this lab is derived from **Canvas Kit** © yaye.work under the MIT License. The original license is retained in this repository.

Jot is maintained separately at https://github.com/Chadillac12/jot and remains the reference implementation for normalized PDF ink/sidecar behavior.
