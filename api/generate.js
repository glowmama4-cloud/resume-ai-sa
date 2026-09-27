import { getAuthedUser, callRpc } from './_lib/auth.js';

const MAX_PROMPT_LENGTH = 12000; // generous for a CV/cover-letter/bio prompt, cheap to enforce
const MIN_SECONDS_BETWEEN_REQUESTS = 3; // basic abuse guard, enforced server-side by reserve_credit()

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Require and verify an authenticated Supabase user. ──
  // The user id used everywhere below comes ONLY from this verified lookup —
  // never from anything the client sends in the request body.
  const { user, error: authError } = await getAuthedUser(req);
  if (!user) {
    const status = authError === 'server_misconfigured' ? 500 : 401;
    return res.status(status).json({
      error:
        authError === 'server_misconfigured'
          ? 'Server not configured correctly.'
          : 'Please sign in to generate a document.',
    });
  }

  // ── 2. Validate the request body. ──
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'No prompt provided.' });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({ error: 'That request is too long. Please shorten it and try again.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured correctly.' });
  }

  // ── 3. Atomically check credits + rate limit + reserve (decrement) a credit. ──
  // reserve_credit() is a Postgres function (see supabase/migrations) that
  // row-locks the user's profile, so two simultaneous requests from the same
  // user cannot both succeed against the same last credit.
  let reservation;
  try {
    const rpcResult = await callRpc('reserve_credit', {
      p_user_id: user.id,
      p_min_interval_seconds: MIN_SECONDS_BETWEEN_REQUESTS,
    });
    reservation = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
  } catch (e) {
    console.error('reserve_credit RPC failed:', e.message);
    return res.status(500).json({ error: 'Could not verify your credits. Please try again.' });
  }

  if (!reservation || !reservation.success) {
    const reason = reservation?.message;
    if (reason === 'rate_limited') {
      return res.status(429).json({ error: 'Please wait a few seconds before trying again.' });
    }
    if (reason === 'no_credits') {
      return res.status(402).json({ error: 'No credits left. Please upgrade to continue.' });
    }
    return res.status(403).json({ error: 'Unable to process this request.' });
  }

  // ── 4. Call the AI. If this fails, refund the credit we just reserved. ──
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      await safeRefund(user.id);
      const err = await response.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || 'AI error. Please try again.' });
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!text) {
      await safeRefund(user.id);
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }

    return res.status(200).json({ text, creditsRemaining: reservation.credits });
  } catch (e) {
    console.error('AI call failed:', e.message);
    await safeRefund(user.id);
    return res.status(502).json({ error: 'Server error. Please try again.' });
  }
}

async function safeRefund(userId) {
  try {
    await callRpc('refund_credit', { p_user_id: userId });
  } catch (e) {
    // Don't fail the request over a refund failure — log it so it can be
    // reconciled. This is the one place a credit could be lost rather than
    // wrongly consumed, which is the safer failure direction.
    console.error('refund_credit RPC failed for user', userId, e.message);
  }
}
