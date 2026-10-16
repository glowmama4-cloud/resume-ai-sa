// Government locations come from the DPSA PDFs, and sometimes the PDF's
// page number got stuck on the end ("Provincial Office: Limpopo 18"), or
// the next post's reference number was glued on. This tidies the location
// for display only — the stored data is not changed. Numbers that are part
// of a real address ("Ward 21", "Gate 3", "Unit 5") are left alone.
const KEEP_NUMBER_AFTER = /\b(ward|unit|block|gate|section|phase|zone|building|floor|room|no|number|ext|extension|platform|wing|hall|region|district|area|cluster|camp|base|station|stand|erf|plot|road|street|avenue|level|bay|sector|township|village|site|precinct)\.?$/i;
function tidyLocation(loc) {
  let t = String(loc || '').replace(/\s+/g, ' ').trim();
  // A reference number at the very start ("Ref No: SSC39/2026: ...") is not a place
  t = t.replace(/^Ref(?:erence)?\.?\s*No\.?\s*:?\s*\S+\s*/i, '').trim();
  // Cut off a reference number (and anything after it) that was glued on.
  // If the advert names more places after it, say so instead of hiding them.
  const cut = t.search(/\s+Ref(?:erence)?\.?\s*No\b/i);
  let more = false;
  if (cut > 0) {
    const rest = t.slice(cut).replace(/Ref(?:erence)?\.?\s*No\.?\s*:?\s*\S+/gi, '').replace(/\(X\d+ Posts?\)/gi, '').replace(/[\s\d().,;:/-]+/g, '');
    more = rest.length > 2;
    t = t.slice(0, cut).trim();
  }
  // Remove a trailing page number, unless it belongs to the address
  const m = t.match(/^(.*?)[\s.,;:]+(\d{1,3})$/);
  if (m && !KEEP_NUMBER_AFTER.test(m[1].trim())) t = m[1].trim();
  t = t.replace(/\s*\(X\d+ Posts?\)/gi, '').replace(/[\s,;:]+$/, '');
  return more ? t + ' · more places in advert' : t;
}

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
  const governmentJob = req.query.government_job; // 'true' | undefined
  // Province filter: only the nine real provinces are accepted, exactly as
  // dpsa-sync.js writes them, so nothing else can be passed through.
  const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
  const province = PROVINCES.includes((req.query.province || '').trim()) ? req.query.province.trim() : '';

  // One specific job (used by "Tailor my CV for this post"). Only a real
  // job id shape is accepted.
  const jobId = /^[0-9a-f-]{36}$/i.test((req.query.id || '').trim()) ? req.query.id.trim() : '';

  const page = parseInt(req.query.page || '1', 10);
  const pageSize = 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('is_active', 'eq.true');
  // Every row in `jobs` gets review_status set (private-sector rows default
  // to 'published', Government rows are explicitly set by dpsa-sync.js based
  // on confidence — see the migration's comment on this column). Filtering
  // on it here is a second, independent layer of protection: even if a
  // pending/rejected Government record were ever mistakenly left
  // is_active=true, it still could not reach a normal jobseeker's search.
  params.set('review_status', 'eq.published');
  // Newest first. Jobs with no posted date (some overseas feeds) go to the
  // end instead of the top — Postgres puts empty dates first by default.
  params.set('order', 'posted_at.desc.nullslast');

  if (jobId) {
    params.set('id', `eq.${jobId}`);
  } else if (employmentType && employmentType !== 'all') {
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
  if (governmentJob === 'true') {
    params.set('government_job', 'eq.true');
  }
  if (jobCategory) {
    params.set('job_category', `eq.${jobCategory}`);
  }
  if (province) {
    params.set('province', `eq.${province}`);
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
    for (const job of jobs) {
      if (job && job.government_job && job.location) job.location = tidyLocation(job.location);
    }
    const contentRange = response.headers.get('content-range');
    const total = contentRange ? parseInt(contentRange.split('/')[1], 10) : jobs.length;

    return res.status(200).json({ jobs, total, page, pageSize });
  } catch (e) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
