export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  const search = (req.query.search || '').trim();
  const employmentType = req.query.employment_type || 'full_time';
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('is_active', 'eq.true');
  params.set('employment_type', `eq.${employmentType}`);
  params.set('order', 'posted_at.desc');

  if (search) {
    params.set('or', `(title.ilike.*${search}*,company_name.ilike.*${search}*)`);
  }

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/jobs?${params.toString()}`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          Range: `${from}-${to}`,
          Prefer: 'count=exact',
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Supabase error: ${err}` });
    }

    const jobs = await response.json();
    const contentRange = response.headers.get('content-range');
    const total = contentRange ? parseInt(contentRange.split('/')[1], 10) : jobs.length;

    return res.status(200).json({ jobs, total, page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
