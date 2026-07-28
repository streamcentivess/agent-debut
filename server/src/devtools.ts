import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";

const exec = promisify(execFile);

const SHOTS_DIR = join(homedir(), ".agent-jones", "screenshots");

// ———— Simulators ————

export interface Sim {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

export async function listSimulators(): Promise<Sim[]> {
  const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  const data = JSON.parse(stdout);
  const sims: Sim[] = [];
  for (const [runtime, devices] of Object.entries<any>(data.devices)) {
    for (const d of devices as any[]) {
      sims.push({
        name: d.name,
        udid: d.udid,
        state: d.state,
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
      });
    }
  }
  return sims;
}

/** Boot the requested (or best available) iPhone simulator and open the Simulator app. */
export async function ensureBooted(udid?: string): Promise<Sim> {
  const sims = await listSimulators();
  let sim = udid ? sims.find((s) => s.udid === udid) : sims.find((s) => s.state === "Booted");
  if (!sim) {
    // Prefer the newest iPhone runtime available.
    const iphones = sims.filter((s) => s.name.startsWith("iPhone")).reverse();
    sim = iphones[0];
  }
  if (!sim) throw new Error("No iOS simulators available. Install one via Xcode → Settings → Platforms.");
  if (sim.state !== "Booted") {
    await exec("xcrun", ["simctl", "boot", sim.udid]).catch((e) => {
      if (!String(e).includes("Unable to boot device in current state: Booted")) throw e;
    });
    await exec("xcrun", ["simctl", "bootstatus", sim.udid, "-b"], { timeout: 120_000 });
  }
  await exec("open", ["-a", "Simulator"]).catch(() => {});
  return { ...sim, state: "Booted" };
}

export async function installAndLaunch(appPath: string, udid: string): Promise<string> {
  const { stdout } = await exec("plutil", [
    "-extract", "CFBundleIdentifier", "raw",
    join(appPath, "Info.plist"),
  ]);
  const bundleId = stdout.trim();
  await exec("xcrun", ["simctl", "install", udid, appPath], { timeout: 120_000 });
  await exec("xcrun", ["simctl", "launch", udid, bundleId], { timeout: 60_000 });
  return bundleId;
}

export async function screenshot(udid = "booted", outPath?: string): Promise<string> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = outPath ?? join(SHOTS_DIR, `shot-${Date.now()}.png`);
  await exec("xcrun", ["simctl", "io", udid, "screenshot", path], { timeout: 30_000 });
  return path;
}

// ———— Build & debug loop ————

function logPath(projectDir: string) {
  const dir = join(projectDir, ".jones");
  mkdirSync(dir, { recursive: true });
  return join(dir, "build.log");
}

export function lastBuildLog(projectDir: string, lines = 120): string {
  const p = logPath(projectDir);
  if (!existsSync(p)) return "No build log yet — run build_app first.";
  const all = readFileSync(p, "utf8").split("\n");
  return all.slice(-lines).join("\n");
}

function extractErrors(log: string): string {
  const errs = log
    .split("\n")
    .filter((l) => /error:|BUILD FAILED|FAILURE:|Undefined symbol|fatal error/i.test(l));
  return errs.slice(0, 30).join("\n") || log.split("\n").slice(-40).join("\n");
}

/** Build the iOS app for the simulator; returns the built .app path. Throws with the error excerpt on failure. */
export async function buildIosSim(projectDir: string): Promise<string> {
  // Capacitor layout first, then a bare Xcode project at the root.
  const capWs = join(projectDir, "ios", "App", "App.xcworkspace");
  const args = ["-sdk", "iphonesimulator", "-configuration", "Debug",
    "-derivedDataPath", join(projectDir, ".jones", "DerivedData"), "build"];
  if (existsSync(capWs)) {
    args.unshift("-workspace", capWs, "-scheme", "App");
  } else {
    const proj = readdirSync(projectDir).find((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"));
    if (!proj) throw new Error("No iOS project found (expected ios/App/App.xcworkspace or a .xcodeproj at the root). Run mobilize_web_app first.");
    args.unshift(proj.endsWith(".xcworkspace") ? "-workspace" : "-project", join(projectDir, proj));
  }
  try {
    const { stdout, stderr } = await exec("xcodebuild", args, {
      cwd: projectDir, timeout: 25 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(logPath(projectDir), stdout + "\n" + stderr);
  } catch (e: any) {
    const log = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
    writeFileSync(logPath(projectDir), log);
    throw new Error("iOS build failed. Errors:\n" + extractErrors(log) + "\n\n(Full log via read_build_log.)");
  }
  const products = join(projectDir, ".jones", "DerivedData", "Build", "Products", "Debug-iphonesimulator");
  const app = existsSync(products) ? readdirSync(products).find((f) => f.endsWith(".app")) : undefined;
  if (!app) throw new Error("Build succeeded but no .app found in " + products);
  return join(products, app);
}

export async function buildAndroid(projectDir: string): Promise<string> {
  const androidDir = join(projectDir, "android");
  if (!existsSync(androidDir)) throw new Error("No android/ directory. Run mobilize_web_app with platforms including android first.");
  try {
    const { stdout, stderr } = await exec("./gradlew", ["assembleDebug"], {
      cwd: androidDir, timeout: 25 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(logPath(projectDir), stdout + "\n" + stderr);
  } catch (e: any) {
    const log = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
    writeFileSync(logPath(projectDir), log);
    throw new Error("Android build failed. Errors:\n" + extractErrors(log) + "\n\n(Full log via read_build_log.)");
  }
  return join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
}

// ———— Work protection ————

const SNAPSHOT_FILE = ".jones/snapshot";
export const WORK_BRANCH = "jones/workbench";

async function git(dir: string, ...args: string[]) {
  return exec("git", ["-C", dir, ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Guard a workspace before Jones changes anything:
 * switch to the jones/workbench branch (never main) and snapshot the tree
 * so restore_snapshot can undo everything with one call.
 */
export async function protectWorkspace(dir: string): Promise<{ branch: string; snapshot: string } | null> {
  try {
    await git(dir, "rev-parse", "--git-dir");
  } catch {
    return null; // not a git repo — nothing to protect
  }
  await git(dir, "checkout", "-B", WORK_BRANCH);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "jones: snapshot before changes", "--no-verify").catch(() => {}); // clean tree is fine
  const { stdout } = await git(dir, "rev-parse", "HEAD");
  const sha = stdout.trim();
  mkdirSync(join(dir, ".jones"), { recursive: true });
  writeFileSync(join(dir, SNAPSHOT_FILE), sha);
  return { branch: WORK_BRANCH, snapshot: sha };
}

/** Undo everything Jones did since the last snapshot. */
export async function restoreSnapshot(dir: string): Promise<string> {
  const p = join(dir, SNAPSHOT_FILE);
  if (!existsSync(p)) throw new Error("No snapshot found — protect_workspace/mobilize_web_app hasn't run here.");
  const sha = readFileSync(p, "utf8").trim();
  await git(dir, "reset", "--hard", sha);
  await git(dir, "clean", "-fd");
  return sha;
}
