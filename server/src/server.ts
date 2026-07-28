import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AscClient } from "./asc/client.js";
import {
  cloneRepo,
  detectWebApp,
  mobilize,
  storeReadinessScan,
} from "./mobilize.js";
import {
  buildAndroid,
  buildIosSim,
  ensureBooted,
  installAndLaunch,
  lastBuildLog,
  listSimulators,
  restoreSnapshot,
  screenshot,
} from "./devtools.js";

const exec = promisify(execFile);

function text(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

function errorText(err: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agent-jones",
    version: "0.1.0",
  });

  // Lazily constructed so the server can start (and list tools) without creds;
  // credential errors surface on first tool call instead.
  let _asc: AscClient | null = null;
  const asc = () => (_asc ??= new AscClient());

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description:
        "List all apps on the connected App Store Connect account (name, bundle id, SKU).",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await asc().listApps());
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "get_app_status",
    {
      title: "Get app status",
      description:
        "Live status for one app: recent App Store versions with their review states, and recent builds with processing states.",
      inputSchema: {
        app_id: z.string().describe("Apple app id (numeric, from list_apps)"),
      },
    },
    async ({ app_id }) => {
      try {
        const [versions, builds] = await Promise.all([
          asc().appVersions(app_id),
          asc().builds(app_id),
        ]);
        return text({ versions, builds });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "create_app_store_version",
    {
      title: "Create App Store version",
      description:
        "Create a new App Store version record for an app (the container you attach a build and metadata to before submitting).",
      inputSchema: {
        app_id: z.string().describe("Apple app id (numeric)"),
        version_string: z.string().describe('Marketing version, e.g. "1.2.0"'),
        platform: z
          .enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])
          .default("IOS")
          .describe("Target platform"),
      },
    },
    async ({ app_id, version_string, platform }) => {
      try {
        return text(await asc().createVersion(app_id, version_string, platform));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "submit_for_review",
    {
      title: "Submit for review",
      description:
        "Submit an App Store version for Apple review. The version must already have a build attached and complete metadata.",
      inputSchema: {
        version_id: z
          .string()
          .describe("appStoreVersions resource id (from get_app_status)"),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to actually submit — submitting to Apple review is irreversible."),
      },
    },
    async ({ version_id, confirm }) => {
      if (!confirm) {
        return text(
          "Submitting to Apple review is irreversible, so Jones asks for an explicit go-ahead. Verify the version's build and metadata with get_app_status, then call submit_for_review again with confirm: true."
        );
      }
      try {
        return text(await asc().submitForReview(version_id));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "stage_build",
    {
      title: "Stage a TestFlight build",
      description:
        "Build, sign, and upload an app to TestFlight using the local fastlane toolchain. Requires fastlane configured in the project directory (a Fastfile with the given lane).",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the app project"),
        lane: z
          .string()
          .default("beta")
          .describe("Fastlane lane to run (default: beta)"),
      },
    },
    async ({ project_dir, lane }) => {
      try {
        const { stdout, stderr } = await exec("fastlane", [lane], {
          cwd: project_dir,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30 * 60 * 1000,
        });
        return text(
          `fastlane ${lane} completed.\n\n${stdout.slice(-4000)}${
            stderr ? `\n[stderr]\n${stderr.slice(-2000)}` : ""
          }`
        );
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "asc_request",
    {
      title: "Raw App Store Connect request",
      description:
        "Escape hatch: perform an arbitrary App Store Connect API v1 request for anything not covered by a dedicated tool (IAP, pricing, localizations, review details, etc.). Path is relative to /v1, e.g. /apps/123/inAppPurchasesV2.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH"]).default("GET"),
        path: z.string().describe("API path starting with /"),
        body: z
          .record(z.unknown())
          .optional()
          .describe("JSON body for POST/PATCH"),
      },
    },
    async ({ method, path, body }) => {
      try {
        const client = asc();
        const result =
          method === "GET"
            ? await client.get(path)
            : method === "POST"
              ? await client.post(path, body)
              : await client.patch(path, body);
        return text(result ?? { ok: true });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "import_repo",
    {
      title: "Import a GitHub repo",
      description:
        "Clone (or update) a GitHub repository into Agent Jones's workspace — the entry point for converting a web app from Lovable, Emergent, Bolt, Replit, v0, or any repo into a mobile app. Returns the local path plus detected framework.",
      inputSchema: {
        repo_url: z.string().describe("Git clone URL, e.g. https://github.com/user/app.git"),
        branch: z.string().optional().describe("Branch to clone (default: repo default)"),
      },
    },
    async ({ repo_url, branch }) => {
      try {
        const dir = await cloneRepo(repo_url, branch);
        return text({ project_dir: dir, detection: detectWebApp(dir) });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "analyze_web_app",
    {
      title: "Analyze web app",
      description:
        "Detect the web framework, build command, and output dir of a project, and report whether it already has a native (Capacitor) shell.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the project (from import_repo)"),
      },
    },
    async ({ project_dir }) => {
      try {
        return text(detectWebApp(project_dir));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "store_readiness_check",
    {
      title: "Store readiness check",
      description:
        "Scan a web app for the refactors iOS App Review and Google Play require before they'll accept it: web checkout that must become IAP/Play Billing, missing account deletion, missing privacy policy, tracking disclosures, minimum-functionality risk. Returns findings with severity and the files involved so the refactor can be applied.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the project"),
      },
    },
    async ({ project_dir }) => {
      try {
        return text(await storeReadinessScan(project_dir));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "mobilize_web_app",
    {
      title: "Convert web app to mobile app",
      description:
        "Refactor a web app into a store-ready native shell: installs Capacitor, writes the native config, builds the web assets, adds the iOS and/or Android platforms, and syncs them. After this, stage_build can ship it to TestFlight.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the project (from import_repo)"),
        app_name: z.string().describe('Display name, e.g. "Streamcentives"'),
        bundle_id: z.string().describe('Reverse-DNS id, e.g. "io.streamcentives.app"'),
        platforms: z
          .array(z.enum(["ios", "android"]))
          .default(["ios", "android"])
          .describe("Which native platforms to add"),
      },
    },
    async ({ project_dir, app_name, bundle_id, platforms }) => {
      try {
        return text(await mobilize(project_dir, app_name, bundle_id, platforms));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "list_simulators",
    {
      title: "List iOS simulators",
      description: "List the iOS simulators available on this Mac (name, udid, state, runtime).",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await listSimulators());
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "build_app",
    {
      title: "Build the app",
      description:
        "Compile the native app with the real toolchain — iOS via xcodebuild (simulator build) or Android via Gradle. On failure, returns the extracted compiler errors so they can be fixed and retried; the full log is available via read_build_log. On success returns the built artifact path.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the project"),
        platform: z.enum(["ios", "android"]).default("ios"),
      },
    },
    async ({ project_dir, platform }) => {
      try {
        const artifact =
          platform === "ios" ? await buildIosSim(project_dir) : await buildAndroid(project_dir);
        return text({ ok: true, artifact });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "read_build_log",
    {
      title: "Read the build log",
      description:
        "Return the tail of the most recent build log for a project — use this to debug a failed build_app or see full compiler output.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the project"),
        lines: z.number().int().min(10).max(2000).default(120),
      },
    },
    async ({ project_dir, lines }) => {
      try {
        return text(lastBuildLog(project_dir, lines));
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "run_in_simulator",
    {
      title: "Run the app in a simulator",
      description:
        "See the app running: boots an iPhone simulator on this Mac (opens the Simulator window), builds the iOS app if needed, installs it, and launches it. Pass app_path to skip the build and install an already-built .app.",
      inputSchema: {
        project_dir: z.string().optional().describe("Project to build & run (omit if passing app_path)"),
        app_path: z.string().optional().describe("Path to an already-built .app bundle"),
        udid: z.string().optional().describe("Specific simulator udid (default: booted or newest iPhone)"),
      },
    },
    async ({ project_dir, app_path, udid }) => {
      try {
        if (!project_dir && !app_path) throw new Error("Provide project_dir or app_path.");
        const app = app_path ?? (await buildIosSim(project_dir!));
        const sim = await ensureBooted(udid);
        const bundleId = await installAndLaunch(app, sim.udid);
        return text({ ok: true, simulator: sim.name, udid: sim.udid, bundleId, app });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "simulator_screenshot",
    {
      title: "Screenshot the simulator",
      description:
        "Capture a PNG of the booted simulator's screen — for checking how the app looks, or producing App Store screenshots. Returns the saved file path.",
      inputSchema: {
        udid: z.string().optional().describe("Simulator udid (default: the booted one)"),
        out_path: z.string().optional().describe("Where to save the PNG (default: ~/.agent-jones/screenshots)"),
      },
    },
    async ({ udid, out_path }) => {
      try {
        return text({ ok: true, path: await screenshot(udid ?? "booted", out_path) });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  server.registerTool(
    "restore_snapshot",
    {
      title: "Undo Jones's changes",
      description:
        "Work protection: roll a workspace back to the snapshot taken before Jones started changing it. Every mobilize_web_app run works on the jones/workbench branch and snapshots first, so this one call undoes everything since.",
      inputSchema: {
        project_dir: z.string().describe("Absolute path to the workspace to roll back"),
      },
    },
    async ({ project_dir }) => {
      try {
        const sha = await restoreSnapshot(project_dir);
        return text({ ok: true, restored_to: sha });
      } catch (e) {
        return errorText(e);
      }
    }
  );

  return server;
}
