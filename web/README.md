# Patron — Command Center

Read-only viewer for the Patron daemon: Quest Board, Decision Log (Claude's reasoning verbatim), and Payment Feed, all live over SSE. No wallet connect, no keys, no auth — see the [root README](../README.md) for the full project.

```bash
npm install
cp .env.example .env   # VITE_DAEMON_URL, defaults to http://localhost:8787
npm run dev
```
