import { createHash } from "node:crypto";

/**
 * Tenant resolution for the hosted gateway.
 *
 * Agents send `Authorization: Bearer debut_sk_...`. We hash it and look up the
 * owning organization with the Supabase service role, which bypasses RLS. The
 * plaintext key is never stored and never logged.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export interface Tenant {
  orgId: string;
  keyId: string;
}

function assertConfigured() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error(
      "Gateway is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
    );
  }
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Resolve a bearer token to an organization, or null if it is not valid. */
export async function tenantFromKey(raw: string | undefined): Promise<Tenant | null> {
  if (!raw?.startsWith("debut_sk_")) return null;
  const rows = await rest<any[]>(
    `api_keys?key_hash=eq.${hashKey(raw)}&revoked_at=is.null&select=id,org_id&limit=1`
  );
  if (!rows.length) return null;

  // Fire and forget: last_used_at is for the user's own audit view.
  rest(`api_keys?id=eq.${rows[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});

  return { orgId: rows[0].org_id, keyId: rows[0].id };
}

/** Queue work for a Mac worker to pick up. */
export async function enqueueJob(
  orgId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const rows = await rest<any[]>("jobs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ org_id: orgId, tool, args, status: "queued" }),
  });
  return rows[0].id;
}

export async function getJob(orgId: string, jobId: string) {
  const rows = await rest<any[]>(
    `jobs?id=eq.${jobId}&org_id=eq.${orgId}&select=id,tool,status,result,error,created_at,finished_at&limit=1`
  );
  return rows[0] ?? null;
}

/** Store credentials for this org, used by read-only tools that run inline. */
export async function appleCredentials(orgId: string) {
  const rows = await rest<any[]>(
    `store_connections?org_id=eq.${orgId}&provider=eq.apple&status=eq.active&select=key_id,issuer_id,credential_path&limit=1`
  );
  if (!rows.length) return null;
  const { key_id, issuer_id, credential_path } = rows[0];

  const dl = await fetch(
    `${SUPABASE_URL}/storage/v1/object/store-credentials/${credential_path}`,
    { headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY } }
  );
  if (!dl.ok) throw new Error("Could not read the stored Apple key.");
  return { keyId: key_id, issuerId: issuer_id, privateKey: await dl.text() };
}

/** Spend credits. Returns false when the balance is exhausted. */
export async function chargeCredits(orgId: string, amount: number, reason: string) {
  const rows = await rest<any[]>(
    `credit_balances?org_id=eq.${orgId}&select=remaining&limit=1`
  );
  const remaining = rows[0]?.remaining ?? 0;
  if (remaining < amount) return false;

  await rest(`credit_balances?org_id=eq.${orgId}`, {
    method: "PATCH",
    body: JSON.stringify({ remaining: remaining - amount, updated_at: new Date().toISOString() }),
  });
  await rest("credit_ledger", {
    method: "POST",
    body: JSON.stringify({ org_id: orgId, delta: -amount, reason }),
  });
  return true;
}

export async function logActivity(
  orgId: string,
  kind: "ok" | "warn" | "err" | "info",
  message: string
) {
  await rest("activity", {
    method: "POST",
    body: JSON.stringify({ org_id: orgId, kind, message }),
  }).catch(() => {});
}
