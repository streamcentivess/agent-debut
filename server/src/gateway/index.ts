/**
 * Hosted MCP gateway for Agent Debut.
 *
 * This is the public endpoint at api.agentdebut.app. It is deliberately thin:
 * it authenticates the caller's organization, then either answers immediately
 * from App Store Connect (fast reads) or queues work for a Mac to run (builds,
 * uploads, conversions). It never compiles anything itself, so it can live on
 * ordinary Linux hosting.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AscClient } from "../asc/client.js";
import {
  appleCredentials,
  chargeCredits,
  enqueueJob,
  getJob,
  logActivity,
  markRefunded,
  refundCredits,
  tenantFromKey,
  type Tenant,
} from "./tenant.js";

/** Work that must happen on a Mac, with what it costs. */
const QUEUED_TOOLS: Record<string, { cost: number; title: string; description: string; schema: any }> = {
  stage_build: {
    cost: 40, title: "Send a build to TestFlight",
    description: "Build, sign, and upload the app to TestFlight. Runs on a Mac and takes roughly 10 to 20 minutes.",
    schema: { repo_url: z.string().describe("Git URL of the app"), branch: z.string().optional() },
  },
  mobilize_web_app: {
    cost: 30, title: "Turn a web app into a mobile app",
    description: "Wrap a web app in a native iOS and Android shell so it can be submitted to the stores.",
    schema: {
      repo_url: z.string().describe("Git URL of the web app"),
      app_name: z.string(), bundle_id: z.string(),
      platforms: z.array(z.enum(["ios", "android"])).default(["ios", "android"]),
    },
  },
  store_readiness_check: {
    cost: 5, title: "Check what would get the app rejected",
    description: "Scan a repository for the things Apple and Google reject: web checkout that must become in-app purchase, missing account deletion, missing privacy policy, undeclared tracking.",
    schema: { repo_url: z.string() },
  },
  build_app: {
    cost: 20, title: "Compile the app",
    description: "Compile for iPhone or Android and return any errors, explained.",
    schema: { repo_url: z.string(), platform: z.enum(["ios", "android"]).default("ios") },
  },
  run_in_simulator: {
    cost: 15, title: "Run the app on a simulated iPhone",
    description: "Boot an iPhone simulator, install the app, launch it, and return a screenshot.",
    schema: { repo_url: z.string() },
  },
};

function text(v: unknown) {
  return { content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] };
}
function fail(msg: string) {
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

function buildServer(tenant: Tenant): McpServer {
  const server = new McpServer({ name: "agent-debut", version: "1.0.0" });

  const asc = async () => {
    const creds = await appleCredentials(tenant.orgId);
    if (!creds) throw new Error(
      "No Apple account connected yet. Connect App Store Connect at https://agentdebut.app/connections.html and try again."
    );
    return new AscClient({
      keyId: creds.keyId, issuerId: creds.issuerId, privateKeyPath: "",
      privateKeyPem: creds.privateKey,
    } as any);
  };

  // ---- fast reads, answered inline ----
  server.registerTool("list_apps", {
    title: "List your apps",
    description: "Every app on the connected App Store Connect account.",
    inputSchema: {},
  }, async () => {
    try { return text(await (await asc()).listApps()); }
    catch (e) { return fail((e as Error).message); }
  });

  server.registerTool("get_app_status", {
    title: "Check an app's status",
    description: "Where an app stands right now: versions, review state, and recent builds.",
    inputSchema: { app_id: z.string().describe("Apple app id from list_apps") },
  }, async ({ app_id }) => {
    try {
      const c = await asc();
      const [versions, builds] = await Promise.all([c.appVersions(app_id), c.builds(app_id)]);
      return text({ versions, builds });
    } catch (e) { return fail((e as Error).message); }
  });

  // ---- work that needs a Mac ----
  for (const [name, spec] of Object.entries(QUEUED_TOOLS)) {
    server.registerTool(name, {
      title: spec.title,
      description: `${spec.description} Costs ${spec.cost} credits. Returns a job id; check it with check_job.`,
      inputSchema: spec.schema,
    }, async (args: any) => {
      try {
        const paid = await chargeCredits(tenant.orgId, spec.cost, name);
        if (!paid) return fail(
          "Not enough credits left this month. Add more at https://agentdebut.app/#pricing"
        );
        const jobId = await enqueueJob(tenant.orgId, name, args);
        await logActivity(tenant.orgId, "info", `${spec.title} started.`);
        return text({
          job_id: jobId, status: "queued", credits_spent: spec.cost,
          next: "Call check_job with this job_id to follow along.",
        });
      } catch (e) { return fail((e as Error).message); }
    });
  }

  server.registerTool("check_job", {
    title: "Check on running work",
    description: "Status and result of a job started by one of the other tools.",
    inputSchema: { job_id: z.string() },
  }, async ({ job_id }) => {
    try {
      const job = await getJob(tenant.orgId, job_id);
      if (!job) return fail("No job with that id for this account.");

      // Failed work is refunded once, the first time anyone looks.
      if (job.status === "failed" && !job.refunded) {
        const cost = QUEUED_TOOLS[job.tool]?.cost ?? 0;
        if (cost) {
          await refundCredits(tenant.orgId, cost, job.tool);
          await markRefunded(job.id);
          await logActivity(tenant.orgId, "warn",
            `${QUEUED_TOOLS[job.tool]?.title ?? job.tool} failed, so we refunded ${cost} credits.`);
          return text({ ...job, credits_refunded: cost,
            note: "This did not finish, so the credits went back to your balance." });
        }
      }
      return text(job);
    } catch (e) { return fail((e as Error).message); }
  });

  return server;
}

// ---------------------------------------------------------------- http layer
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "agent-debut-gateway" }));

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const tenant = await tenantFromKey(bearer).catch(() => null);
  if (!tenant) {
    res.status(401).json({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: "Missing or invalid API key. Create one at https://agentdebut.app/dashboard.html" },
    });
    return;
  }

  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport = sid ? transports.get(sid) : undefined;

  if (!transport) {
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0", id: null,
        error: { code: -32000, message: "Send an initialize request first." },
      });
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport!); },
    });
    transport.onclose = () => { if (transport!.sessionId) transports.delete(transport!.sessionId); };
    await buildServer(tenant).connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

const bySession = async (req: express.Request, res: express.Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const t = sid ? transports.get(sid) : undefined;
  if (!t) { res.status(400).send("Unknown session"); return; }
  await t.handleRequest(req, res);
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`agent-debut gateway listening on :${port}`));
