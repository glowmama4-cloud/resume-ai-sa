// Pulls remote, full-time jobs from 5 free public job APIs, cleans them into
// one consistent shape, enriches them with structured filter fields, and
// saves them into your Supabase `jobs` table. Protected by CRON_SECRET so
// only you (or a scheduled job) can trigger it.
//
// Phase 3 additions on top of the original sync:
//   - country / remote_scope / job_category inferred per job
//   - last_seen_at stamped on every job this run still finds
//   - jobs a source stops returning for 3+ days get marked is_active=false
//     (per source — a failing source never causes other sources' jobs to
//     be wrongly deactivated)
//   - jobs with a closing_date in the past get marked is_active=false too
//     (currently no source reliably provides one, but this is here for
//     when a source — e.g. a future government integration — does)

const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function guessEmploymentType(raw) {
  if (!raw) return 'unknown';
  const r = String(raw).toLowerCase();
  if (r.includes('full')) return 'full_time';
  if (r.includes('part')) return 'part_time';
  if (r.includes('contract') || r.includes('freelance')) return 'contract';
  return 'unknown';
}

function toTagArray(v) {
  if (Array.isArray(v)) return v.map((t) => String(t)).slice(0, 20);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((t) => t.trim()).slice(0, 20);
  return [];
}

function titleCaseSlug(slug) {
  if (!slug) return 'Unknown';
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Phase 3: structured-field inference ──
// These are best-effort text heuristics against whatever free-text location
// string each source provides — none of the 5 sources give a clean
// structured country/region field (Adzuna is the one exception; it's
// request-scoped by country, so fetchAdzuna() sets `country` directly and
// this function leaves it alone).

const COUNTRY_HINTS = [
  [/\bsouth africa\b|\bza\b/i, 'ZA'],
  [/\bunited states\b|\busa\b|\bu\.s\.a?\.?\b/i, 'US'],
  [/\bunited kingdom\b|\buk\b/i, 'GB'],
  [/\bcanada\b/i, 'CA'],
  [/\baustralia\b/i, 'AU'],
  [/\bgermany\b/i, 'DE'],
  [/\bireland\b/i, 'IE'],
  [/\bnetherlands\b/i, 'NL'],
  [/\bindia\b/i, 'IN'],
  [/\bsingapore\b/i, 'SG'],
];

const REGION_HINTS = [
  /\bemea\b/i,
  /\bapac\b/i,
  /\beurope\b/i,
  /\bnorth america\b/i,
  /\blatam\b|\blatin america\b/i,
];

function inferCountry(job) {
  if (job.country) return job.country; // already set (e.g. by fetchAdzuna)
  const loc = job.location || '';
  for (const [pattern, code] of COUNTRY_HINTS) {
    if (pattern.test(loc)) return code;
  }
  if (/\bworldwide\b|\banywhere\b/i.test(loc)) return 'Worldwide';
  return null; // genuinely unknown — do not guess
}

function inferRemoteScope(job) {
  const loc = (job.location || '').toLowerCase();

  if (!job.is_remote) {
    if (loc.includes('hybrid')) return 'hybrid';
    if (loc.trim()) return 'onsite';
    return 'unknown';
  }

  if (job.country === 'ZA' || /\bsouth africa\b/i.test(loc)) return 'south_africa';
  if (/\bworldwide\b|\banywhere\b/i.test(loc) || !loc.trim()) return 'worldwide';
  if (REGION_HINTS.some((r) => r.test(loc))) return 'region_restricted';
  if (COUNTRY_HINTS.some(([pattern]) => pattern.test(loc))) return 'country_restricted';
  return 'unknown';
}

function inferJobCategory(title) {
  const t = title || '';
  if (/\bintern(ship)?\b/i.test(t) && !/\binternational\b/i.test(t)) return 'internship';
  if (/\blearnership\b/i.test(t)) return 'learnership';
  if (/\bgraduate\b/i.test(t)) return 'graduate_programme';
  return 'general';
}

function enrichJob(job) {
  const country = inferCountry(job);
  const withCountry = { ...job, country };
  return {
    ...withCountry,
    remote_scope: inferRemoteScope(withCountry),
    job_category: inferJobCategory(job.title),
    last_seen_at: new Date().toISOString(),
  };
}

// ── Sources ──

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
      tags: toTagArray(j.tags),
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
      tags: toTagArray(j.tags),
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
      company_name: titleCaseSlug(j.companySlug) || j.companyName || 'Unknown',
      company_logo_url: null, // Himalayas free API returns a placeholder, not a real logo URL
      location: (j.locationRestrictions && j.locationRestrictions.join(', ')) || 'Worldwide',
      is_remote: true,
      employment_type: guessEmploymentType(j.employmentType || j.type),
      salary_text: j.minSalary && j.maxSalary ? `${j.minSalary}-${j.maxSalary}` : null,
      description: j.description ? String(j.description).slice(0, 2000) : null,
      apply_url: j.applicationLink || j.url,
      tags: toTagArray(j.tags || j.skills),
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
        tags: toTagArray(j.tags),
        posted_at: j.date ? new Date(j.date).toISOString() : null,
      }));
  } catch {
    return [];
  }
}

async function fetchAdzuna() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return []; // optional source, skip if not configured

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
          country: country.toUpperCase(), // Adzuna is queried per-country, so this is reliable
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

const SOURCES = [
  { name: 'arbeitnow', fetch: fetchArbeitnow },
  { name: 'remotive', fetch: fetchRemotive },
  { name: 'himalayas', fetch: fetchHimalayas },
  { name: 'remoteok', fetch: fetchRemoteOK },
  { name: 'adzuna', fetch: fetchAdzuna },
];

export default async function handler(req, res) {
  // Header-only auth. Vercel's native Cron adds
  // `Authorization: Bearer ${CRON_SECRET}` automatically to scheduled
  // requests once the CRON_SECRET env var is set — no secret needs to
  // appear in vercel.json or in any URL/query string.
  if (!process.env.CRON_SECRET) {
    console.error('jobs-sync: CRON_SECRET not configured on server');
    return res.status(500).json({ error: 'Server not configured correctly.' });
  }

  const authHeader = req.headers.authorization;
  const validHeader = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!validHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Run each source independently so one failing source can't take the
  // others down, and so we know exactly which sources actually returned
  // data this run (needed for the per-source expiry step below).
  const results = await Promise.allSettled(SOURCES.map((s) => s.fetch()));

  const perSourceCounts = {};
  let jobs = [];
  results.forEach((r, i) => {
    const name = SOURCES[i].name;
    const value = r.status === 'fulfilled' ? r.value : [];
    perSourceCounts[name] = value.length;
    jobs.push(...value);
  });

  jobs = jobs.filter((j) => j.title && j.company_name && j.apply_url);
  jobs = jobs.map((j) => enrichJob({ ...j, tags: toTagArray(j.tags) }));

  if (jobs.length === 0) {
    return res.status(502).json({ ok: false, message: 'No jobs fetched from any source' });
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/jobs?on_conflict=source,source_job_id`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
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
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error while saving jobs.' });
  }

  // ── Expiry ──
  // 1. Per successful source: a job we haven't seen in 3+ days has
  //    disappeared from that source's feed — mark it inactive. Sources
  //    that returned 0 jobs this run (likely a transient failure) are
  //    skipped entirely, so a source outage never wrongly deactivates
  //    everything from that source.
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const expiredBySource = {};
  for (const source of Object.keys(perSourceCounts)) {
    if (perSourceCounts[source] === 0) continue;
    try {
      const params = new URLSearchParams();
      params.set('source', `eq.${source}`);
      params.set('is_active', 'eq.true');
      params.set('last_seen_at', `lt.${staleCutoff}`);
      const r = await fetch(`${supabaseUrl}/rest/v1/jobs?${params.toString()}`, {
        method: 'PATCH',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ is_active: false }),
      });
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        expiredBySource[source] = Array.isArray(rows) ? rows.length : 0;
      }
    } catch (e) {
      console.error('Expiry step failed for source', source, e.message);
    }
  }

  // 2. Any job (any source) whose closing_date has passed. No current
  // source reliably sets closing_date, so this is normally a no-op today —
  // it's here so a future source that does provide one is handled correctly
  // without further code changes.
  let closedByDate = 0;
  try {
    const params = new URLSearchParams();
    params.set('is_active', 'eq.true');
    params.set('closing_date', `lt.${new Date().toISOString()}`);
    const r = await fetch(`${supabaseUrl}/rest/v1/jobs?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ is_active: false }),
    });
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      closedByDate = Array.isArray(rows) ? rows.length : 0;
    }
  } catch (e) {
    console.error('Closing-date expiry step failed:', e.message);
  }

  return res.status(200).json({
    ok: true,
    synced: jobs.length,
    perSource: perSourceCounts,
    expiredStale: expiredBySource,
    expiredByClosingDate: closedByDate,
  });
}
