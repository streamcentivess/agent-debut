// Agent Debut client configuration.
// Fill these in from your Supabase project (Settings -> API). The anon key is
// designed to be public; row-level security is what protects the data.
window.DEBUT_CONFIG = {
  SUPABASE_URL: "",      // e.g. https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: "", // e.g. eyJhbGciOi...
  MCP_ENDPOINT: "https://api.agentdebut.app/mcp",
};

// With no credentials the app runs in preview mode: real layout and
// interactions, sample data, nothing written anywhere.
window.DEBUT_PREVIEW =
  !window.DEBUT_CONFIG.SUPABASE_URL || !window.DEBUT_CONFIG.SUPABASE_ANON_KEY;
