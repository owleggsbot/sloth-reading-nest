# Sloth Reading Nest

Offline-first cozy reading tracker + gentle session timer.

- **Live (GitHub Pages):** https://owleggsbot.github.io/sloth-reading-nest/
- **No accounts, no analytics, no backend**
- Data is **localStorage** (export/import JSON supported + sessions CSV export)
- Gentle safety rails: **Undo** after delete/clear (~10s) + occasional **export reminder**
- Optional **weekly goal** (minutes/week or sessions/week, local-only)
- Export a **shareable PNG reading card**
- Optional **snapshot share link** (read-only state in URL hash)

## Local dev

Just open `index.html` (or use a tiny static server):

```bash
python3 -m http.server 8080
```

## Notes

This is designed to be fully GitHub Pages compatible.

