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

async function supabase() {
  if (PREVIEW) return null;
  if (client) return client;
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
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

  /** Current signed-in user, or null. */
  async user() {
    if (PREVIEW) {
      return sessionStorage.getItem("debut:preview-signed-in")
        ? PREVIEW_USER
        : null;
    }
    const sb = await supabase();
    const { data } = await sb.auth.getUser();
    if (!data?.user) return null;
    const m = data.user.user_metadata ?? {};
    return {
      email: data.user.email,
      name: m.full_name || m.user_name || data.user.email?.split("@")[0],
      avatar: m.avatar_url ?? null,
      id: data.user.id,
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
