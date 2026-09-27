import crypto from 'crypto';
import { callRpc } from './_lib/auth.js';

export const config = {
  api: {
    bodyParser: false, // PayFast sends form-encoded data, not JSON — we parse it ourselves below
  },
};

// Plan → { price PayFast must report, credits to grant }. Keep this in
// sync with the prices shown in index.html's paywall — do not change
// prices here without also changing them there (and vice versa).
const PLANS = {
  starter: { price: 30.0, credits: 3 },
  pro: { price: 99.0, credits: 30 },
};

const AMOUNT_TOLERANCE = 0.05; // rand, to allow for float rounding

function parseFormBody(raw) {
  // URLSearchParams preserves insertion order, which we need for the
  // signature check below (PayFast signs fields in the order they were
  // sent, not alphabetically).
  const params = new URLSearchParams(raw);
  const ordered = [];
  const obj = {};
  for (const [key, value] of params.entries()) {
    ordered.push([key, value]);
    obj[key] = value;
  }
  return { obj, ordered };
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Mirrors PHP's urlencode(), which is what PayFast's own signature
// generation uses (space -> '+', and a few chars encodeURIComponent
// leaves alone that PHP encodes).
function phpUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildSignatureString(orderedFields, passphrase) {
  const parts = orderedFields
    .filter(([key]) => key !== 'signature')
    .map(([key, value]) => `${key}=${phpUrlEncode(value)}`);
  if (passphrase) {
    parts.push(`passphrase=${phpUrlEncode(passphrase)}`);
  }
  return parts.join('&');
}

function verifySignature(orderedFields, receivedSignature) {
  if (!receivedSignature) return false;
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';
  const signatureString = buildSignatureString(orderedFields, passphrase);
  const computed = crypto.createHash('md5').update(signatureString).digest('hex');
  return computed.toLowerCase() === String(receivedSignature).toLowerCase();
}

// PayFast's recommended "server confirmation" step: post the raw ITN body
// back to PayFast and check it echoes VALID. Catches tampering a signature
// check alone might miss, and is the officially documented approach.
async function confirmWithPayfast(rawBody) {
  const host =
    process.env.PAYFAST_MODE === 'sandbox'
      ? 'https://sandbox.payfast.co.za/eng/query/validate'
      : 'https://www.payfast.co.za/eng/query/validate';
  try {
    const r = await fetch(host, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
    });
    const text = (await r.text()).trim();
    return text === 'VALID';
  } catch (e) {
    console.error('PayFast server confirmation failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  let raw, obj, ordered;
  try {
    raw = await readRawBody(req);
    ({ obj: obj, ordered } = parseFormBody(raw));
  } catch (e) {
    console.error('Could not parse notify body:', e.message);
    return res.status(400).send('Bad request');
  }

  const data = obj;

  // 1. Signature.
  if (!verifySignature(ordered, data.signature)) {
    console.error('PayFast ITN: signature mismatch');
    return res.status(400).send('Invalid signature');
  }

  // 2. Payment status.
  if (data.payment_status !== 'COMPLETE') {
    // Not an error — PayFast also sends non-complete statuses. Acknowledge
    // and do nothing further.
    return res.status(200).send('OK');
  }

  // 3. Merchant identity.
  const expectedMerchantId = process.env.PAYFAST_MERCHANT_ID || '35795225';
  if (data.merchant_id !== expectedMerchantId) {
    console.error('PayFast ITN: merchant_id mismatch', data.merchant_id);
    return res.status(400).send('Merchant mismatch');
  }

  // 4. Server confirmation with PayFast itself.
  const confirmed = await confirmWithPayfast(raw);
  if (!confirmed) {
    console.error('PayFast ITN: server confirmation failed');
    return res.status(400).send('Could not confirm with PayFast');
  }

  // 5. Plan + amount.
  const plan = data.custom_str1;
  const planConfig = PLANS[plan];
  if (!planConfig) {
    console.error('PayFast ITN: unknown plan', plan);
    return res.status(400).send('Unknown plan');
  }

  const amountGross = parseFloat(data.amount_gross);
  if (!Number.isFinite(amountGross) || Math.abs(amountGross - planConfig.price) > AMOUNT_TOLERANCE) {
    console.error('PayFast ITN: amount mismatch', { plan, expected: planConfig.price, got: data.amount_gross });
    return res.status(400).send('Amount mismatch');
  }

  // 6. User.
  const userId = data.custom_str2;
  if (!userId) {
    console.error('PayFast ITN: no user id in payload');
    return res.status(400).send('No user ID');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('PayFast ITN: Supabase not configured on server');
    return res.status(500).send('Server error');
  }

  const profileCheck = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=id`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const profileRows = await profileCheck.json().catch(() => []);
  if (!profileCheck.ok || !Array.isArray(profileRows) || profileRows.length === 0) {
    console.error('PayFast ITN: unknown user', userId);
    return res.status(400).send('Unknown user');
  }

  // 7. Idempotency — insert the payment record first, using a unique
  // constraint on pf_payment_id (see migration). If this insert reports
  // zero rows, we've already processed this exact notification, so we
  // acknowledge without crediting again. This also covers PayFast retrying
  // the same ITN more than once.
  const pfPaymentId = data.pf_payment_id || data.m_payment_id;
  try {
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/payment_logs`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify([
        {
          user_id: userId,
          email: data.custom_str3 || null,
          amount: amountGross,
          plan,
          status: 'complete',
          pf_payment_id: pfPaymentId || null,
        },
      ]),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('payment_logs insert failed:', insertRes.status, errText);
      return res.status(500).send('Failed to record payment');
    }

    const inserted = await insertRes.json().catch(() => []);
    if (!Array.isArray(inserted) || inserted.length === 0) {
      // Duplicate notification for a payment we've already credited.
      console.log('PayFast ITN: duplicate notification, already processed', pfPaymentId);
      return res.status(200).send('OK');
    }
  } catch (e) {
    console.error('payment_logs insert error:', e.message);
    return res.status(500).send('Server error');
  }

  // 8. Grant credits — atomically, server-side only.
  try {
    await callRpc('add_credits', { p_user_id: userId, p_amount: planConfig.credits });
  } catch (e) {
    console.error('add_credits RPC failed:', e.message);
    return res.status(500).send('Failed to update credits');
  }

  console.log(`Credits added for user ${userId}: +${planConfig.credits} (${plan})`);
  return res.status(200).send('OK');
}
