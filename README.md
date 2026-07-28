# Agent Jones

**Jones ships the app from any coding agent.** Connect Jones to the tools you
already use, then Agent Jones handles screenshots, listings, and App Store
submission for you.

- [`docs/`](docs/) — marketing landing page (static, zero dependencies; open
  `docs/index.html` or serve the folder)
- [`server/`](server/) — the product: an MCP server wrapping the App Store
  Connect API + fastlane (stdio for local agents, streamable HTTP for hosting),
  plus a web→mobile pipeline: import a GitHub repo (Lovable, Emergent, Bolt,
  Replit, v0, …), scan it for App Store / Play compliance blockers, and wrap it
  into a store-ready iOS/Android app with Capacitor

## Quick start

```bash
cd server && npm install && npm run build && npm run start:http
```

Then point any MCP-capable agent (Claude Code, Cursor, Codex, Copilot, …) at
`http://localhost:8787/mcp`.
