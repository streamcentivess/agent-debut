import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AscClient } from "./asc/client.js";

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
    name: "agent-smith",
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
      },
    },
    async ({ version_id }) => {
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

  return server;
}
