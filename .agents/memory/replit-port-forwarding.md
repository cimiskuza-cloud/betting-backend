---
name: Replit port forwarding
description: Persistence behavior for manual .replit port mappings alongside managed workflows.
---

Managed workflow restarts can regenerate `.replit` and remove manually added `[[ports]]` mappings in this workspace.

**Why:** The app can be healthy on its local port while the portless webview still returns 404 because the forwarding configuration did not persist.

**How to apply:** After changing `.replit` port mappings, re-read the real file after the workflow restart and test both localhost and the external webview; do not assume a successful config-validation response means the mapping survived.