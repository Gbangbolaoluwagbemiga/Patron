# Patron — Command Center

Multi-page command center for the Patron daemon: Dashboard, Quest Board, Job Detail, Decision Log (the LLM brain's reasoning verbatim), and Payment Feed — all live over SSE. Read-only against Patron's own keys (none of them ever reach the browser); the one "Connect Wallet" button only lets a visitor fund the treasury from their own wallet. See the [root README](../README.md) for the full project.

```bash
npm install
cp .env.example .env   # VITE_DAEMON_URL, defaults to http://localhost:8787
npm run dev
```
