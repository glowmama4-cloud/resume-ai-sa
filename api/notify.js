export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  try {
    const data = req.body;
    if (!data || data.payment_status !== 'COMPLETE') return res.status(200).send('OK');
    const userId = data.custom_str2;
    const plan   = data.custom_str1;
    if (!userId) return res.status(400).send('No user ID');
    const creditsToAdd = plan === 'pro' ? 30 : 3;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const getRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=credits`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const getData = await getRes.json();
    const newCredits = (getData?.[0]?.credits || 0) + creditsToAdd;
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ credits: newCredits })
    });
    return res.status(200).send('OK');
  } catch(err) {
    return res.status(500).send('Server error');
  }
}
