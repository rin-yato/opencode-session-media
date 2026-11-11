---
"opencode-session-media": patch
---

Bound the image cache (256 MB / 200 images, LRU) and serve disk images as revocable blob URLs instead of base64 strings that were never freed.
