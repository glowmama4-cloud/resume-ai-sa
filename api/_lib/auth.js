// Server-side Supabase auth helper.
//
// IMPORTANT: this never trusts a user id sent by the client. It takes the
// bearer token from the Authorization header, asks Supabase Auth to verify
// it, and returns the user Supabase itself resolved from that token.
//
// No extra npm dependency — uses plain fetch, same pattern the rest of the
// API routes already use to talk to Supabase.

export async function getAuthedUser(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { user: null, error: 'missing_token' };

  const accessToken = match[1].trim();
  if (!accessToken) return { user: null, error: 'missing_token' };

  const supabaseUrl = process.env.SUPABASE_URL;
  // Any valid project API key works for the `apikey` header here — it just
  // identifies the project. The actual identity check is the user's own
  // access token, verified by Supabase.
  const apiKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !apiKey) {
    return { user: null, error: 'server_misconfigured' };
  }

  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!r.ok) {
      return { user: null, error: 'invalid_token' };
    }

    const user = await r.json();
    if (!user || !user.id) {
      return { user: null, error: 'invalid_token' };
    }

    return { user, error: null };
  } catch (e) {
    return { user: null, error: 'auth_check_failed' };
  }
}

// Small helper to call a Postgres RPC function via PostgREST using the
// service role key (server-only — never expose SUPABASE_SERVICE_KEY to the
// browser).
export async function callRpc(fnName, args) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('server_misconfigured');
  }

  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`rpc_failed:${fnName}:${r.status}:${text}`);
  }

  return r.json();
}
