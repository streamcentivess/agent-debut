# Agent Smith

**Smith ships the app from any coding agent.** Connect Smith to the tools you
already use, then Agent Smith handles screenshots, listings, and App Store
submission for you.

- [`site/`](site/) — marketing landing page (static, zero dependencies; open
  `site/index.html` or serve the folder)
- [`server/`](server/) — the product: an MCP server wrapping the App Store
  Connect API + fastlane (stdio for local agents, streamable HTTP for hosting)

## Quick start

```bash
cd server && npm install && npm run build && npm run start:http
```

Then point any MCP-capable agent (Claude Code, Cursor, Codex, Copilot, …) at
`http://localhost:8787/mcp`.
