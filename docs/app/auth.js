/**
 * Auth layer for Agent Debut.
 *
 * Uses Supabase Auth, which runs entirely from the browser, so the whole app
 * stays on static hosting with no server to operate. When Supabase credentials
 * are absent the module falls back to preview mode so the UI is still usable.
 */
const cfg = window.DEBUT_CONFIG;
const PREVIEW = window.DEBUT_PREVIEW;

let client = null;

/** Never let a hung network call freeze the whole page. */
export function withTimeout(promise, ms, label = "request") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function supabase() {
  if (PREVIEW) return null;
  if (client) return client;
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Opt out of the cross-tab Web Lock. It is meant to stop two tabs
      // refreshing a token at once, but a stale lock leaves every later call
      // hanging forever, which is a far worse failure than a duplicate refresh.
      lock: async (_name, _acquireTimeout, fn) => fn(),
    },
  });
  return client;
}

const PREVIEW_USER = {
  email: "you@yourcompany.com",
  name: "Preview",
  avatar: null,
  preview: true,
};

export const auth = {
  preview: PREVIEW,

  /**
   * Which sign-in methods this project actually has switched on.
   * Lets the sign-in page hide buttons that would only produce an error.
   */
  async enabledProviders() {
    if (PREVIEW) return { email: true, github: true, google: true };
    try {
      const r = await fetch(`${cfg.SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: cfg.SUPABASE_ANON_KEY },
      });
      const s = await r.json();
      return {
        email: !s.disable_signup,
        github: !!s.external?.github,
        google: !!s.external?.google,
      };
    } catch {
      return { email: true, github: true, google: true };
    }
  },

  /**
   * Current signed-in user, or null.
   *
   * Reads the stored session rather than calling getUser(), which hits the
   * network and takes a cross-tab lock that can stall indefinitely when several
   * tabs are open. Everything shown in the interface is already in the session.
   */
  async user() {
    if (PREVIEW) {
      return sessionStorage.getItem("debut:preview-signed-in")
        ? PREVIEW_USER
        : null;
    }
    const sb = await supabase();
    const { data } = await withTimeout(sb.auth.getSession(), 8000, "getSession");
    const u = data?.session?.user;
    if (!u) return null;
    const m = u.user_metadata ?? {};
    return {
      email: u.email,
      name: m.full_name || m.user_name || u.email?.split("@")[0],
      avatar: m.avatar_url ?? null,
      id: u.id,
    };
  },

  /** Start an OAuth redirect. provider: "github" | "google" */
  async signInWithProvider(provider) {
    if (PREVIEW) {
      sessionStorage.setItem("debut:preview-signed-in", "1");
      location.href = "dashboard.html";
      return;
    }
    const sb = await supabase();
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: new URL("dashboard.html", location.href).href },
    });
    if (error) throw error;
  },

  /** Email magic link, no password to type or remember. */
  async signInWithEmail(email) {
    if (PREVIEW) {
      sessionStorage.setItem("debut:preview-signed-in", "1");
      return { preview: true };
    }
    const sb = await supabase();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: new URL("dashboard.html", location.href).href },
    });
    if (error) throw error;
    return { sent: true };
  },

  async signOut() {
    if (PREVIEW) {
      sessionStorage.removeItem("debut:preview-signed-in");
    } else {
      const sb = await supabase();
      await sb.auth.signOut();
    }
    location.href = "index.html";
  },

  /** Send anyone who is not signed in back to the sign-in page. */
  async requireUser() {
    const u = await this.user();
    if (!u) {
      location.href = "signin.html";
      return null;
    }
    return u;
  },
};

export default auth;
