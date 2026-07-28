import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { protectWorkspace } from "./devtools.js";

const exec = promisify(execFile);

export const WORKSPACES = join(homedir(), ".agent-jones", "workspaces");

/** Shallow-clone (or update) a GitHub repo into the Agent Jones workspace. */
export async function cloneRepo(repoUrl: string, branch?: string): Promise<string> {
  mkdirSync(WORKSPACES, { recursive: true });
  const name = repoUrl
    .replace(/\.git$/, "")
    .split("/")
    .slice(-2)
    .join("__")
    .replace(/[^\w.-]/g, "_");
  const dir = join(WORKSPACES, name);
  if (existsSync(join(dir, ".git"))) {
    await exec("git", ["-C", dir, "pull", "--ff-only"], { timeout: 120_000 });
  } else {
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(repoUrl, dir);
    await exec("git", args, { timeout: 300_000 });
  }
  return dir;
}

export interface Detection {
  framework: string;
  buildCommand: string | null;
  webDir: string | null;
  hasCapacitor: boolean;
  notes: string[];
}

/** Figure out what kind of web app lives in `dir` and how to build it. */
export function detectWebApp(dir: string): Detection {
  const notes: string[] = [];
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    if (existsSync(join(dir, "index.html"))) {
      return { framework: "static", buildCommand: null, webDir: ".", hasCapacitor: false, notes };
    }
    return {
      framework: "unknown",
      buildCommand: null,
      webDir: null,
      hasCapacitor: false,
      notes: ["No package.json or index.html found — is this a web app?"],
    };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasCapacitor =
    !!deps["@capacitor/core"] ||
    existsSync(join(dir, "capacitor.config.ts")) ||
    existsSync(join(dir, "capacitor.config.json"));

  let framework = "unknown";
  let webDir: string | null = "dist";
  if (deps.next) {
    framework = "next";
    webDir = "out";
    notes.push(
      "Next.js must use static export for a native wrapper: set `output: 'export'` in next.config, or keep the app remote and point Capacitor's server.url at your deployment."
    );
  } else if (deps.vite) {
    framework = "vite";
  } else if (deps["react-scripts"]) {
    framework = "create-react-app";
    webDir = "build";
  } else if (deps["@angular/core"]) {
    framework = "angular";
    notes.push("Angular outputs to dist/<project-name>/browser — confirm the exact webDir after building.");
  } else if (deps.nuxt) {
    framework = "nuxt";
    webDir = ".output/public";
    notes.push("Use `nuxi generate` for a static build.");
  } else if (deps.svelte || deps["@sveltejs/kit"]) {
    framework = "svelte";
    notes.push("SvelteKit needs adapter-static for a native wrapper.");
  }
  const buildCommand = pkg.scripts?.build ? "npm run build" : null;
  if (!buildCommand) notes.push("No build script in package.json.");
  return { framework, buildCommand, webDir, hasCapacitor, notes };
}

export interface Finding {
  severity: "blocker" | "warning" | "info";
  rule: string;
  detail: string;
  files: string[];
}

async function grepFiles(dir: string, pattern: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "grep",
      [
        "-RIlE",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        pattern,
        dir,
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 5)
      .map((f) => f.replace(dir + "/", ""));
  } catch {
    return []; // grep exits non-zero on no match
  }
}

/**
 * Scan a web app for the things Apple and Google most often reject
 * wrapped web apps for, so Jones (or the calling agent) can refactor them.
 */
export async function storeReadinessScan(dir: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const payments = await grepFiles(
    dir,
    "stripe|paypal|checkout\\.|lemonsqueezy|gumroad|paddle"
  );
  if (payments.length) {
    findings.push({
      severity: "blocker",
      rule: "Payments (App Store 3.1.1 / Play Payments policy)",
      detail:
        "Web checkout detected. Digital goods/subscriptions inside the app must use Apple IAP / Google Play Billing (or be removed/hidden in the native build). Physical goods and reader-app exceptions may apply.",
      files: payments,
    });
  }

  const auth = await grepFiles(dir, "supabase|firebase/auth|auth0|clerk|next-auth");
  if (auth.length) {
    const deletion = await grepFiles(dir, "delete[ _-]?account|account[ _-]?deletion");
    if (!deletion.length) {
      findings.push({
        severity: "blocker",
        rule: "Account deletion (App Store 5.1.1(v) / Play User Data)",
        detail:
          "The app has account creation but no in-app account deletion flow was found. Both stores require one.",
        files: auth,
      });
    }
  }

  const privacy = await grepFiles(dir, "privacy[ _-]?policy|/privacy");
  if (!privacy.length) {
    findings.push({
      severity: "blocker",
      rule: "Privacy policy (both stores)",
      detail:
        "No privacy policy link found. Both stores require a reachable privacy policy URL in the app and the listing.",
      files: [],
    });
  }

  const analytics = await grepFiles(dir, "gtag|google-analytics|mixpanel|posthog|fbq\\(|hotjar");
  if (analytics.length) {
    findings.push({
      severity: "warning",
      rule: "Tracking (App Tracking Transparency / Play Data safety)",
      detail:
        "Analytics/tracking SDKs detected. iOS may require an ATT prompt; declare everything in Apple privacy nutrition labels and the Play Data safety form.",
      files: analytics,
    });
  }

  const external = await grepFiles(dir, "window\\.open|target=[\"']_blank");
  if (external.length) {
    findings.push({
      severity: "warning",
      rule: "External links out of the app",
      detail:
        "Links that escape to the browser feel broken in a native wrapper. Route them through the Capacitor Browser plugin or keep flows in-app.",
      files: external,
    });
  }

  findings.push({
    severity: "info",
    rule: "Minimum functionality (App Store 4.2)",
    detail:
      "Pure web wrappers get rejected as 'just a website'. Add native value before submitting: push notifications, offline support, haptics, share sheet, or widgets — Jones can wire Capacitor plugins for these.",
    files: [],
  });

  return findings;
}

export interface MobilizeResult {
  steps: string[];
  detection: Detection;
  protection: { branch: string; snapshot: string } | null;
  nextSteps: string[];
}

/**
 * Refactor a web app into a store-ready native shell:
 * install Capacitor, write config, build the web assets, add iOS/Android
 * platforms, and sync.
 */
export async function mobilize(
  dir: string,
  appName: string,
  bundleId: string,
  platforms: ("ios" | "android")[]
): Promise<MobilizeResult> {
  const steps: string[] = [];
  const detection = detectWebApp(dir);
  if (!detection.webDir) throw new Error("Could not detect a web app in " + dir);

  // Work protection: never touch the user's branch; snapshot so one call undoes everything.
  const protection = await protectWorkspace(dir);
  if (protection) steps.push(`protected workspace: branch ${protection.branch}, snapshot ${protection.snapshot.slice(0, 8)}`);
  const run = async (cmd: string, args: string[], timeout = 900_000) => {
    await exec(cmd, args, { cwd: dir, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: "1" } });
    steps.push(`${cmd} ${args.join(" ")}`);
  };

  await run("npm", ["install", "--no-fund", "--no-audit"]);
  const capPkgs = ["@capacitor/core", "@capacitor/cli", ...platforms.map((p) => `@capacitor/${p}`)];
  await run("npm", ["install", "--no-fund", "--no-audit", ...capPkgs]);

  const configPath = join(dir, "capacitor.config.json");
  if (!existsSync(configPath) && !existsSync(join(dir, "capacitor.config.ts"))) {
    writeFileSync(
      configPath,
      JSON.stringify({ appId: bundleId, appName, webDir: detection.webDir }, null, 2)
    );
    steps.push(`wrote capacitor.config.json (appId=${bundleId}, webDir=${detection.webDir})`);
  }

  if (!existsSync(join(dir, detection.webDir)) && detection.buildCommand) {
    await run("npm", ["run", "build"]);
  }
  for (const p of platforms) {
    if (!existsSync(join(dir, p))) await run("npx", ["cap", "add", p]);
  }
  await run("npx", ["cap", "sync"]);

  return {
    steps,
    detection,
    protection,
    nextSteps: [
      "Run store_readiness_check and refactor any blockers (payments → IAP/Play Billing, account deletion, privacy policy).",
      "Generate app icons and splash screens (npx @capacitor/assets generate).",
      "Add at least one native capability (push, haptics, share) to clear App Store 4.2 minimum functionality.",
      "iOS: open ios/App in Xcode once for signing, or hand the repo to Jones's stage_build for TestFlight.",
      "Android: build an .aab with cd android && ./gradlew bundleRelease for Play Console.",
    ],
  };
}
