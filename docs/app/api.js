/**
 * Data layer for Agent Debut.
 *
 * Every call goes to Supabase (Postgres + Storage) when a project is
 * configured, and falls back to browser-local preview data when it is not, so
 * the interface is always usable while the backend is being stood up.
 *
 * Security note on store credentials: the Apple .p8 and the Google service
 * account JSON go into a PRIVATE storage bucket. Row-level security limits
 * reads to the owning organization, and only the Mac worker, holding the
 * service role key, ever pulls them back out. They are never returned to the
 * browser and never handed to a model.
 */
const cfg = window.DEBUT_CONFIG;
const PREVIEW = window.DEBUT_PREVIEW;
const BUCKET = "store-credentials";

let client = null;
async function sb() {
  if (PREVIEW) return null;
  if (client) return client;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return client;
}

let cachedOrg = null;

/**
 * The caller's organization.
 *
 * Accounts created before the signup trigger existed have no organization, so
 * fall back to bootstrap_org(), which creates one on demand and is safe to call
 * repeatedly.
 */
async function orgId() {
  if (cachedOrg) return cachedOrg;
  const c = await sb();
  const { data: { user } } = await c.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data } = await c
    .from("memberships").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (data?.org_id) return (cachedOrg = data.org_id);

  const { data: made, error } = await c.rpc("bootstrap_org");
  if (error) throw new Error("Could not set up your workspace: " + error.message);
  return (cachedOrg = made);
}

/* ---------- preview store ---------- */
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("debut:" + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("debut:" + k, JSON.stringify(v)); },
};

export const api = {
  preview: PREVIEW,

  /** Which stores are connected. */
  async connections() {
    if (PREVIEW) return local.get("connections", { apple: false, google: false });
    const c = await sb();
    const { data, error } = await c
      .from("store_connections").select("provider, status").eq("org_id", await orgId());
    if (error) throw new Error(error.message);
    return {
      apple: data.some(r => r.provider === "apple" && r.status === "active"),
      google: data.some(r => r.provider === "google" && r.status === "active"),
    };
  },

  /** Store an Apple App Store Connect API key. */
  async connectApple({ keyId, issuerId, file }) {
    if (!/^[A-Z0-9]{8,12}$/i.test(keyId)) throw new Error("That Key ID does not look right.");
    if (!/^[0-9a-f-]{30,40}$/i.test(issuerId)) throw new Error("That Issuer ID does not look right.");
    if (!file.name.endsWith(".p8")) throw new Error("Apple's file should end in .p8");

    if (PREVIEW) {
      local.set("connections", { ...local.get("connections", {}), apple: true });
      return { ok: true, preview: true };
    }
    const c = await sb();
    const org = await orgId();
    const path = `${org}/apple/${keyId}.p8`;
    const up = await c.storage.from(BUCKET).upload(path, file, { upsert: true });
    if (up.error) throw new Error(up.error.message);

    const { error } = await c.from("store_connections").upsert({
      org_id: org, provider: "apple", status: "active",
      key_id: keyId, issuer_id: issuerId, credential_path: path,
    }, { onConflict: "org_id,provider" });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  /** Store a Google Play service account. */
  async connectGoogle({ file }) {
    if (!file.name.endsWith(".json")) throw new Error("Google's file should end in .json");
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new Error("That file is not valid JSON."); }
    if (!parsed.client_email || !parsed.private_key)
      throw new Error("That JSON is missing the service account details.");

    if (PREVIEW) {
      local.set("connections", { ...local.get("connections", {}), google: true });
      return { ok: true, preview: true };
    }
    const c = await sb();
    const org = await orgId();
    const path = `${org}/google/service-account.json`;
    const up = await c.storage.from(BUCKET).upload(path, file, { upsert: true });
    if (up.error) throw new Error(up.error.message);

    const { error } = await c.from("store_connections").upsert({
      org_id: org, provider: "google", status: "active",
      service_account_email: parsed.client_email, credential_path: path,
    }, { onConflict: "org_id,provider" });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  /** Apps this organization is shipping. */
  async apps() {
    if (PREVIEW) return null; // dashboard falls back to its sample set
    const c = await sb();
    const { data, error } = await c.from("apps")
      .select("*").eq("org_id", await orgId()).order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  /** Recent operator activity. */
  async activity(limit = 8) {
    if (PREVIEW) return null;
    const c = await sb();
    const { data, error } = await c.from("activity")
      .select("*").eq("org_id", await orgId())
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data;
  },

  /** Keys this org has issued. The secret itself is never returned again. */
  async keys() {
    if (PREVIEW) return local.get("keys", []);
    const c = await sb();
    const { data, error } = await c.from("api_keys")
      .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
      .eq("org_id", await orgId())
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  /** Mint a key. The plaintext comes back exactly once, so show it now. */
  async createKey(name = "My AI tool") {
    if (PREVIEW) {
      const fake = "debut_sk_" + Array.from({ length: 48 },
        () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
      const list = local.get("keys", []);
      list.unshift({ id: crypto.randomUUID(), name, key_prefix: fake.slice(0, 17) + "...",
        created_at: new Date().toISOString(), last_used_at: null });
      local.set("keys", list);
      return fake;
    }
    const c = await sb();
    const { data, error } = await c.rpc("create_api_key", { key_name: name });
    if (error) throw new Error(error.message);
    return data;
  },

  async revokeKey(id) {
    if (PREVIEW) {
      local.set("keys", local.get("keys", []).filter(k => k.id !== id));
      return;
    }
    const c = await sb();
    const { error } = await c.from("api_keys")
      .update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(error.message);
  },

  /** Where the credits went, newest first. */
  async usage(limit = 20) {
    if (PREVIEW) return null;
    const c = await sb();
    const { data, error } = await c.from("credit_ledger")
      .select("delta, reason, created_at").eq("org_id", await orgId())
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data;
  },

  /** Credit balance for the meter. */
  async credits() {
    if (PREVIEW) return { remaining: 2140, included: 2500 };
    const c = await sb();
    const { data, error } = await c.from("credit_balances")
      .select("remaining, included").eq("org_id", await orgId()).single();
    if (error) throw new Error(error.message);
    return data;
  },
};

export default api;
