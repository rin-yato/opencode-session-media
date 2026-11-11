# opencode-session-media

## 0.2.0

### Minor Changes

- 9c740d2: Replace the justified rows with a uniform grid grouped by turn, with captions, group headers, and a small/medium/large density switch.

### Patch Changes

- 9b603df: Bound the image cache (256 MB / 200 images, LRU) and serve disk images as revocable blob URLs instead of base64 strings that were never freed.
- 9b603df: Serve downscaled thumbnails to grid tiles instead of full-resolution images; the viewer still opens the original.
- 9b603df: Load only new messages when a run ends or a session is reopened, instead of re-walking the whole history.
- 9b603df: Find image paths with spaces in tool output (quoted, escaped, `file://`, spaced names); guessed ones show only if the file exists.

## 0.1.2

### Patch Changes

- Automated patch release.

## 0.1.1

### Patch Changes

- 850dd47: Add screenshots of the panel and the viewer to the README.
