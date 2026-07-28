# Agent Debut — MCP server

An autonomous App Store Connect operator exposed as an MCP server. Your agent
builds the app; Agent Debut ships it.

## Setup

1. Create an App Store Connect API key (App Store Connect → Users and Access →
   Integrations → App Store Connect API), role **App Manager** or higher, and
   download the `.p8` file.
2. Copy `.env.example` to `.env` (or export the variables) and fill in
   `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`.
3. Install and build:

```bash
npm install && npm run build
```

## Run

**Stdio (local, for Claude Code / Cursor):**

```bash
claude mcp add agent-debut -e ASC_KEY_ID=... -e ASC_ISSUER_ID=... -e ASC_KEY_PATH=... -- node /path/to/agent-debut/server/dist/index.js
```

**Streamable HTTP (hosted, `https://your-host/mcp`):**

```bash
npm run start:http
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_apps` | All apps on the account |
| `get_app_status` | Versions + review states + recent builds for one app |
| `create_app_store_version` | New version container for a release |
| `submit_for_review` | Submit a version to Apple review |
| `stage_build` | Build, sign, and upload to TestFlight via local fastlane |
| `asc_request` | Raw ASC API v1 escape hatch (IAP, pricing, localizations, …) |
| `import_repo` | Clone a GitHub repo (Lovable, Emergent, Bolt, Replit, v0, …) into the workspace |
| `analyze_web_app` | Detect framework, build command, web output dir, existing native shell |
| `store_readiness_check` | Scan for App Store / Play rejection risks: web checkout vs IAP, account deletion, privacy policy, tracking, minimum functionality |
| `mobilize_web_app` | Refactor a web app into a native shell: Capacitor install + config, build, add iOS/Android, sync (runs on `debut/workbench` branch with a pre-change snapshot) |
| `build_app` | Compile iOS (xcodebuild → simulator) or Android (Gradle); failures return extracted compiler errors |
| `read_build_log` | Tail of the last build log for debugging |
| `run_in_simulator` | Boot an iPhone simulator, build/install the app, launch it |
| `simulator_screenshot` | PNG of the booted simulator screen (App Store screenshot source) |
| `list_simulators` | Available iOS simulators on this Mac |
| `restore_snapshot` | Work protection: roll the workspace back to the pre-change snapshot |

## Work protection

- Debut only edits cloned workspaces, on a `debut/workbench` branch — never the user's branch.
- A snapshot commit is taken before changes; `restore_snapshot` undoes everything in one call.
- `submit_for_review` requires `confirm: true` — irreversible store actions never happen implicitly.

## Notes

- ASC JWTs are minted per-request with a 15-minute lifetime and cached.
- `stage_build` shells out to `fastlane <lane>` in the target project — the
  machine running the server needs Xcode + fastlane + signing set up (`match`
  recommended).
- The `.p8` key never leaves this machine; agents only ever see tool results.
