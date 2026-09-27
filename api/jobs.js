export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  // Strip characters that are meaningful in a PostgREST filter expression
  // (commas/parens can otherwise be used to inject extra filter clauses
  // into the `or=(...)` string built below). Jobs data is public either
  // way, but there's no reason to let a search box alter query structure.
  const search = (req.query.search || '').trim().replace(/[(),]/g, '');

  // employment_type: 'all' (or omitted-but-other-filters-present) means no
  // filter; otherwise default stays 'full_time' to match existing behaviour.
  const employmentType = req.query.employment_type || 'full_time';

  // Phase 3: new structured filters. Each is optional; only applied when
  // the caller actually sends a value, and only against real columns
  // populated by jobs-sync.js — no filter here can match a category that
  // doesn't exist in the data.
  const remoteScope = (req.query.remote_scope || '').trim();   // e.g. 'worldwide', 'south_africa'
  const country = (req.query.country || '').trim();             // e.g. 'ZA'
  const excludeCountry = (req.query.exclude_country || '').trim(); // e.g. 'ZA' -> everything NOT South Africa
  const jobCategory = (req.query.job_category || '').trim();    // e.g. 'internship'
  const isRemoteParam = req.query.is_remote; // 'true' | 'false' | undefined

  const page = parseInt(req.query.page || '1', 10);
  const pageSize = 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('is_active', 'eq.true');
  params.set('order', 'posted_at.desc');

  if (employmentType && employmentType !== 'all') {
    params.set('employment_type', `eq.${employmentType}`);
  }
  if (remoteScope) {
    params.set('remote_scope', `eq.${remoteScope}`);
  }
  if (country) {
    params.set('country', `eq.${country}`);
  }
  if (excludeCountry) {
    params.set('country', `neq.${excludeCountry}`);
  }
  if (isRemoteParam === 'true' || isRemoteParam === 'false') {
    params.set('is_remote', `eq.${isRemoteParam}`);
  }
  if (jobCategory) {
    params.set('job_category', `eq.${jobCategory}`);
  }
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
