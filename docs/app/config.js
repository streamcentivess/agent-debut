// Agent Debut client configuration.
// The publishable key is meant to ship in the browser. Row-level security and
// table grants are what actually protect the data, never the secrecy of this key.
window.DEBUT_CONFIG = {
  SUPABASE_URL: "https://ggkedugdbkdmmrosedpw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_kVENyiH3m7ySFPXvDWJVkQ_2nErQYR8",
  MCP_ENDPOINT: "https://api.agentdebut.app/mcp",
};

// With no credentials the app runs in preview mode: real layout and
// interactions, sample data, nothing written anywhere.
window.DEBUT_PREVIEW =
  !window.DEBUT_CONFIG.SUPABASE_URL || !window.DEBUT_CONFIG.SUPABASE_ANON_KEY;
