// DPSA (Department of Public Service and Administration) Government Jobs sync.
//
// Source of truth: the official Public Service Vacancy Circulars at
// https://www.dpsa.gov.za/newsroom/psvc/ . Each weekly circular page links
// one small PDF per department / province ("annexure"). We read those, turn
// every post into its own vacancy, and save it in the `jobs` table.
//
// What this version fixes (October 2026):
//   1. pdf.js is imported statically, so Vercel actually bundles it. The old
//      createRequire() call was invisible to Vercel's file tracer, so the
//      library was missing in production and every run failed.
//   2. A failed run no longer marks a circular as "done" forever. Only a run
//      that imported every department writes the "importer v2: complete"
//      log entry that makes later runs skip that circular.
//   3. The last 3 circulars are checked (posts stay open 2-3 weeks), not
//      only the newest one.
//   4. Work is split per department PDF and stops safely before Vercel's
//      time limit; the next run carries on where this one stopped.
//   5. Better reading of "how to apply" (online portals such as
//      westerncape.gov.za/jobs, kznonline.gov.za, erecruitment.mpg.gov.za),
//      internship stipends, sub-departments inside provincial annexures.
//      All of that lives in ./_lib/dpsaParse.js.
//
// Nothing is guessed: a field that cannot be found stays empty. HIGH and
// MEDIUM confidence posts are published (every one keeps a link to the
// official PDF). LOW confidence posts go to the admin review queue.
// Posts whose closing date has already passed are never published.

import pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.js';
import { parseVacancies } from './_lib/dpsaParse.js';

// Run pdf.js's worker code in this same process (no separate worker file).
globalThis.pdfjsWorker = pdfjsWorker;

export const config = {
  maxDuration: 60,
};

const DPSA_BASE = 'https://www.dpsa.gov.za';
const LISTING_URL = `${DPSA_BASE}/newsroom/psvc/`;
const CIRCULARS_TO_CHECK = 3;
const TIME_BUDGET_MS = 45 * 1000;      // stop starting new work after 45s
const MIN_TIME_FOR_A_FILE_MS = 8 * 1000;
const COMPLETE_NOTE = 'importer v2: complete';
const FETCH_HEADERS = { 'User-Agent': 'ResumeAI-SA jobs importer (+https://www.resumeaisa.co.za)' };

// ── 1. Which circulars are on the DPSA listing page? (newest first) ──
async function discoverCirculars() {
  const r = await fetch(LISTING_URL, { headers: FETCH_HEADERS });
  if (!r.ok) throw new Error(`Could not reach DPSA listing page (${r.status})`);
  const html = await r.text();
  const seen = new Map();
  for (const m of html.matchAll(/Circular\s+(\d+)\s+of\s+(\d{4})/gi)) {
    const number = parseInt(m[1], 10);
    const year = parseInt(m[2], 10);
    seen.set(`${year}-${number}`, { number, year });
  }
  if (seen.size === 0) throw new Error('No circulars found on the DPSA listing page.');
  return [...seen.values()]
    .sort((a, b) => b.year - a.year || b.number - a.number)
    .slice(0, CIRCULARS_TO_CHECK)
    .map((c) => {
      const padded = String(c.number).padStart(2, '0');
      return {
        ...c,
        sourceUrl: `${DPSA_BASE}/newsroom/psvc/circular-${c.number}-of-${c.year}/`,
        masterPdfUrl: `${DPSA_BASE}/dpsa2g/documents/vacancies/${c.year}/PSV%20CIRCULAR%20${padded}%20of%20${c.year}.pdf`,
      };
    });
}

// ── 2. The per-department PDFs listed on one circular's page ──
async function listDepartmentPdfs(circular) {
  const r = await fetch(circular.sourceUrl, { headers: FETCH_HEADERS });
  if (!r.ok) throw new Error(`Could not open circular ${circular.number} page (${r.status})`);
  const html = await r.text();
  const re = new RegExp(
    `href="([^"]*\\/vacancies\\/${circular.year}\\/${circular.number}\\/([a-z]{1,2})\\.pdf)"[^>]*>([^<]*)<`,
    'gi'
  );
  const files = [];
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    const url = new URL(m[1], DPSA_BASE).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    files.push({ url, letter: m[2].toUpperCase(), label: m[3].trim() });
  }
  // Older circulars without per-department files: fall back to the full PDF.
  if (files.length === 0) {
    files.push({ url: circular.masterPdfUrl, letter: null, label: 'Full circular' });
  }
  return files;
}

// ── 3. Download one PDF and get its text, plus where its links sit ──
async function readPdf(url) {
  const r = await fetch(url, { headers: FETCH_HEADERS });
  if (!r.ok) throw new Error(`Could not download ${url} (${r.status})`);
  const data = new Uint8Array(await r.arrayBuffer());

  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  let text = '';
  const positions = []; // { offset, page, y } for every text item, in order
  const links = [];     // { page, y, url }

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      positions.push({ offset: text.length, page: p, y: item.transform ? item.transform[5] : 0 });
      text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    text += '\n';

    const annots = await page.getAnnotations();
    for (const a of annots) {
      if (a.subtype === 'Link' && a.url) {
        links.push({ page: p, y: a.rect ? a.rect[1] : 0, url: a.url });
      }
    }
    page.cleanup();
  }
  await doc.destroy();

  // The PDF link annotation closest to a given character position
  // (used for "CLICK HERE to apply" style adverts).
  function linkAt(offset) {
    let lo = 0;
    let hi = positions.length - 1;
    let at = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid].offset <= offset) { at = positions[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!at) return null;
    let best = null;
    let bestDist = Infinity;
    for (const l of links) {
      if (l.page !== at.page) continue;
      const dist = Math.abs(l.y - at.y);
      if (dist < bestDist && dist < 60) { best = l.url; bestDist = dist; }
    }
    return best;
  }

  return { text, linkAt, pageCount: doc.numPages };
}

// ── 4. Supabase helpers (service key, server-side only) ──
function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async get(path) {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers });
      if (!r.ok) throw new Error(`Supabase read failed (${r.status}): ${await r.text()}`);
      return r.json();
    },
    async upsertJobs(records) {
      const r = await fetch(`${url}/rest/v1/jobs?on_conflict=source,source_job_id`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(records),
      });
      if (!r.ok) throw new Error(`Saving vacancies failed (${r.status}): ${await r.text()}`);
    },
    async log(row) {
      try {
        const r = await fetch(`${url}/rest/v1/dpsa_sync_log`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify([row]),
        });
        // If the table only allows one row per circular, update that row instead.
        if (r.status === 409) {
          await fetch(
            `${url}/rest/v1/dpsa_sync_log?circular_number=eq.${row.circular_number}&circular_year=eq.${row.circular_year}`,
            {
              method: 'PATCH',
              headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify(row),
            }
          );
        } else if (!r.ok) {
          console.error('dpsa-sync: sync log write failed:', r.status, await r.text());
        }
      } catch (e) {
        console.error('dpsa-sync: could not write sync log:', e.message);
      }
    },
  };
}

function toRecord(v, circular, file, now) {
  const isPublished = v.confidence === 'high' || v.confidence === 'medium';
  return {
    source: 'dpsa',
    source_job_id: v.source_job_id,
    government_job: true,
    title: v.title || `Government vacancy ${v.post_number}`,
    company_name: v.company_name,
    department: v.department,
    province: v.province,
    annexure: v.annexure,
    post_number: v.post_number,
    circular_number: circular.number,
    circular_year: circular.year,
    reference_number: v.reference_number,
    location: v.location,
    country: 'ZA',
    is_remote: false,
    remote_scope: 'onsite',
    employment_type: 'full_time',
    job_category: v.job_category,
    salary_text: v.salary_text,
    salary_level: v.salary_level,
    requirements: v.requirements,
    duties: v.duties,
    description: v.duties || v.requirements || null,
    enquiries: v.enquiries,
    application_instructions: v.application_instructions,
    application_method: v.application_method,
    apply_url: v.official_application_url || file.url,
    official_application_url: v.official_application_url,
    official_source_url: circular.sourceUrl,
    official_pdf_url: file.url,
    closing_date: v.closing_date,
    confidence_level: v.confidence,
    review_status: isPublished ? 'published' : 'pending_review',
    is_active: isPublished,
    posted_at: now,
    last_seen_at: now,
    tags: v.warnings,
  };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error('dpsa-sync: CRON_SECRET not configured on server');
    return res.status(500).json({ error: 'Server not configured correctly.' });
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  const started = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started);
  const db = sb();
  const report = [];

  let circulars;
  try {
    circulars = await discoverCirculars();
  } catch (e) {
    console.error('dpsa-sync:', e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }

  for (const circular of circulars) {
    const summary = { circular: `${circular.number} of ${circular.year}` };
    report.push(summary);

    if (timeLeft() < MIN_TIME_FOR_A_FILE_MS) { summary.status = 'not reached (time)'; continue; }

    // Already fully imported by this version?
    try {
      const done = await db.get(
        `dpsa_sync_log?circular_number=eq.${circular.number}&circular_year=eq.${circular.year}` +
        `&status=eq.ok&error_message=eq.${encodeURIComponent(COMPLETE_NOTE)}&select=id&limit=1`
      );
      if (Array.isArray(done) && done.length) { summary.status = 'already complete'; continue; }
    } catch (e) {
      console.error('dpsa-sync: log check failed, continuing:', e.message);
    }

    let files;
    try {
      files = await listDepartmentPdfs(circular);
    } catch (e) {
      summary.status = 'failed';
      summary.error = e.message;
      await db.log({
        circular_number: circular.number, circular_year: circular.year, pdf_url: circular.sourceUrl,
        vacancies_detected: 0, vacancies_published: 0, vacancies_review: 0,
        vacancies_skipped_erratum: 0, parsing_warnings: 0, status: 'failed', error_message: e.message,
      });
      continue;
    }

    // Departments already published in an earlier run (resume support)
    let alreadyImported = new Set();
    try {
      const rows = await db.get(
        `jobs?source=eq.dpsa&circular_number=eq.${circular.number}&circular_year=eq.${circular.year}` +
        `&review_status=eq.published&select=annexure&limit=2000`
      );
      alreadyImported = new Set(rows.map((r) => r.annexure).filter(Boolean));
    } catch (e) {
      console.error('dpsa-sync: could not read existing jobs, continuing:', e.message);
    }

    let detected = 0;
    let published = 0;
    let review = 0;
    let expired = 0;
    let warnings = 0;
    let finished = 0;
    const errors = [];
    const now = new Date().toISOString();

    for (const file of files) {
      if (file.letter && alreadyImported.has(file.letter)) { finished++; continue; }
      if (timeLeft() < MIN_TIME_FOR_A_FILE_MS) break;
      try {
        const pdf = await readPdf(file.url);
        const vacancies = parseVacancies(pdf.text, circular, { linkAt: pdf.linkAt });
        detected += vacancies.length;

        const records = [];
        for (const v of vacancies) {
          if (v.closing_date && new Date(v.closing_date).getTime() < Date.now()) { expired++; continue; }
          warnings += v.warnings.length;
          const rec = toRecord(v, circular, file, now);
          if (rec.is_active) published++; else review++;
          records.push(rec);
        }
        if (records.length) await db.upsertJobs(records);
        finished++;
      } catch (e) {
        console.error(`dpsa-sync: circular ${circular.number} file ${file.url} failed:`, e.message);
        errors.push(`${file.label}: ${e.message}`.slice(0, 300));
      }
    }

    const complete = finished === files.length && errors.length === 0;
    Object.assign(summary, {
      status: complete ? 'complete' : 'partial (continues next run)',
      departmentFiles: files.length,
      departmentsDone: finished,
      vacanciesDetected: detected,
      published,
      sentToReview: review,
      skippedClosed: expired,
      errors,
    });

    await db.log({
      circular_number: circular.number,
      circular_year: circular.year,
      pdf_url: circular.sourceUrl,
      vacancies_detected: detected,
      vacancies_published: published,
      vacancies_review: review,
      vacancies_skipped_erratum: 0,
      parsing_warnings: warnings,
      status: complete ? 'ok' : (errors.length ? 'failed' : 'partial'),
      error_message: complete ? COMPLETE_NOTE : (errors.join(' | ').slice(0, 1000) || 'stopped early to stay within the time limit'),
    });
  }

  return res.status(200).json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), circulars: report });
}
