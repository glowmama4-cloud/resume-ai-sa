function guessEmploymentType(raw) {
  if (!raw) return 'unknown';
  const r = String(raw).toLowerCase();
  if (r.includes('full')) return 'full_time';
  if (r.includes('part')) return 'part_time';
  if (r.includes('contract') || r.includes('freelance')) return 'contract';
  return 'unknown';
}

async function fetchArbeitnow() {
  try {
    const r = await fetch('https://www.arbeitnow.com/api/job-board-api');
    if (!r.ok) return [];
    const data = await r.json();
    return (data.data || []).map((j) => ({
      source: 'arbeitnow',
      source_job_id: String(j.slug),
      title: j.title,
      company_name: j.company_name,
      company_logo_url: null,
      location: j.location || (j.remote ? 'Remote' : null),
      is_remote: !!j.remote,
      employment_type: guessEmploymentType((j.job_types || []).join(' ')),
      salary_text: null,
      description: j.description ? String(j.description).slice(0, 2000) : null,
      apply_url: j.url,
      tags: j.tags || [],
      posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

async function fetchRemotive() {
  try {
    const r = await fetch('https://remotive.com/api/remote-jobs');
    if (!r.ok) return [];
    const data = await r.json();
    return (data.jobs || []).map((j) => ({
      source: 'remotive',
      source_job_id: String(j.id),
      title: j.title,
      company_name: j.company_name,
      company_logo_url: j.company_logo || null,
      location: j.candidate_required_location || 'Worldwide',
      is_remote: true,
      employment_type: guessEmploymentType(j.job_type),
      salary_text: j.salary || null,
      description: j.description ? String(j.description).slice(0, 2000) : null,
      apply_url: j.url,
      tags: j.tags || [],
      posted_at: j.publication_date ? new Date(j.publication_date).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

async function fetchHimalayas() {
  try {
    const r = await fetch('https://himalayas.app/jobs/api');
    if (!r.ok) return [];
    const data = await r.json();
    return (data.jobs || []).map((j) => ({
      source: 'himalayas',
      source_job_id: String(j.id ?? j.guid ?? j.slug),
      title: j.title,
      company_name: j.companyName,
      company_logo_url: j.companyLogo || null,
      location: (j.locationRestrictions && j.locationRestrictions.join(', ')) || 'Worldwide',
      is_remote: true,
      employment_type: guessEmploymentType(j.employmentType || j.type),
      salary_text: j.minSalary && j.maxSalary ? `${j.minSalary}-${j.maxSalary}` : null,
      description: j.description ? String(j.description).slice(0, 2000) : null,
      apply_url: j.applicationLink || j.url,
      tags: j.tags || j.skills || [],
      posted_at: j.publishedAt ? new Date(j.publishedAt * 1000).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

async function fetchRemoteOK() {
  try {
    const r = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'ResumeAISA-Careers-Bot (contact: keolebogileva@gmail.com)' },
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data || [])
      .filter((j) => j && j.id)
      .map((j) => ({
        source: 'remoteok',
        source_job_id: String(j.id),
        title: j.position,
        company_name: j.company,
        company_logo_url: j.company_logo || null,
        location: j.location || 'Worldwide',
        is_remote: true,
        employment_type: 'unknown',
        salary_text: j.salary_min && j.salary_max ? `${j.salary_min}-${j.salary_max}` : null,
        description: j.description ? String(j.description).slice(0, 2000) : null,
        apply_url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
        tags: j.tags || [],
        posted_at: j.date ? new Date(j.date).toISOString() : null,
      }));
  } catch {
    return [];
  }
}

async function fetchAdzuna() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];

  const countries = ['us', 'gb', 'za', 'au', 'ca', 'de'];
  const results = [];
  for (const country of countries) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=25&full_time=1`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      for (const j of data.results || []) {
        results.push({
          source: 'adzuna',
          source_job_id: String(j.id),
          title: j.title,
          company_name: j.company?.display_name || 'Unknown',
          company_logo_url: null,
          location: j.location?.display_name || country.toUpperCase(),
          is_remote: /remote/i.test(j.title) || /remote/i.test(j.description || ''),
          employment_type: guessEmploymentType(j.contract_time),
          salary_text: j.salary_min && j.salary_max ? `${j.salary_min}-${j.salary_max}` : null,
          description: j.description ? String(j.description).slice(0, 2000) : null,
          apply_url: j.redirect_url,
          tags: [],
          posted_at: j.created || null,
        });
      }
    } catch {
      continue;
    }
  }
  return results;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({
      error: 'Unauthorized',
      debug: {
        received: authHeader ? authHeader.slice(0, 15) + '...' : 'NONE',
        receivedLength: authHeader ? authHeader.length : 0,
        expectedLength: process.env.CRON_SECRET ? process.env.CRON_SECRET.length : 0,
      },
    });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  const results = await Promise.allSettled([
    fetchArbeitnow(),
    fetchRemotive(),
    fetchHimalayas(),
    fetchRemoteOK(),
    fetchAdzuna(),
  ]);

  let jobs = [];
  for (const r of results) {
    if (r.status === 'fulfilled') jobs.push(...r.value);
  }
  jobs = jobs.filter((j) => j.title && j.company_name && j.apply_url);

  if (jobs.length === 0) {
    return res.status(502).json({ ok: false, message: 'No jobs fetched from any source' });
  }

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/jobs?on_conflict=source,source_job_id`,
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(jobs),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ ok: false, error: err });
    }

    return res.status(200).json({ ok: true, synced: jobs.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error while saving jobs.' });
  }
}
