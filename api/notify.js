export const config = {
  api: {
    bodyParser: false, // PayFast sends form-encoded data, not JSON — we parse it ourselves below
  },
};

function parseFormBody(raw) {
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [key, value] of params.entries()) {
    obj[key] = value;
  }
  return obj;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  try {
    const raw = await readRawBody(req);
    const data = parseFormBody(raw);

    console.log('PayFast notify payload:', data);

    if (!data || data.payment_status !== 'COMPLETE') {
      console.log('Payment not complete or no data, status:', data?.payment_status);
      return res.status(200).send('OK');
    }

    const userId = data.custom_str2;
    const plan   = data.custom_str1;

    if (!userId) {
      console.log('No user ID in payload');
      return res.status(400).send('No user ID');
    }

    const creditsToAdd = plan === 'pro' ? 30 : 3;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    const getRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=credits`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const getData = await getRes.json();
    const newCredits = (getData?.[0]?.credits || 0) + creditsToAdd;

    const patchRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ credits: newCredits })
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Supabase PATCH failed:', patchRes.status, errText);
      return res.status(500).send('Failed to update credits');
    }

    console.log(`Credits updated for user ${userId}: ${newCredits}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Notify handler error:', err);
    return res.status(500).send('Server error');
  }
}
