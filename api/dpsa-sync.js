// DPSA (Department of Public Service and Administration) Government Jobs sync.
//
// Source of truth: the official Public Service Vacancy Circular listing at
// https://www.dpsa.gov.za/newsroom/psvc/ and the single consolidated master
// PDF each weekly circular publishes (confirmed during the proof-of-concept
// against the real, current circular — see the Phase 3 DPSA report).
//
// This does NOT hardcode a circular number. It discovers the latest one from
// the listing page every run, and skips re-processing a circular it has
// already handled (tracked in dpsa_sync_log).
//
// Confidence model: only HIGH confidence vacancies are published
// (is_active=true, review_status='published'). MEDIUM/LOW go to
// review_status='pending_review' with is_active=false, for a human to check
// in admin.html. Nothing is ever guessed into existence — a field we can't
// find stays null and pulls the record's confidence down instead.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const PROVINCIAL_ADMINISTRATIONS = [
  'GAUTENG',
  'KWAZULU NATAL',
  'KWAZULU-NATAL',
  'LIMPOPO',
  'NORTH WEST',
  'WESTERN CAPE',
  'EASTERN CAPE',
  'FREE STATE',
  'MPUMALANGA',
  'NORTHERN CAPE',
];

const FIELD_LABELS = [
  'SALARY',
  'CENTRE',
  'REQUIREMENTS',
  'DUTIES',
  'ENQUIRIES',
  'APPLICATIONS',
  'FOR ATTENTION',
  'NOTE',
  'CLOSING DATE',
];

const ERRATUM_PATTERN = /\b(ERRATUM|WITHDRAWN|WITHDRAWAL|CORRECTION|AMENDMENT)\b/i;

// ── 1. Discover the latest circular ──
async function discoverLatestCircular() {
  const listingUrl = 'https://www.dpsa.gov.za/newsroom/psvc/';
  const r = await fetch(listingUrl);
  if (!r.ok) throw new Error(`Could not reach DPSA listing page (${r.status})`);
  const html = await r.text();

  // Matches link text like "Circular 34 of 2026"
  const matches = [...html.matchAll(/Circular\s+(\d+)\s+of\s+(\d{4})/gi)];
  if (matches.length === 0) throw new Error('Could not find any circular listed on the DPSA page.');

  let latest = null;
  for (const m of matches) {
    const number = parseInt(m[1], 10);
    const year = parseInt(m[2], 10);
    if (!latest || year > latest.year || (year === latest.year && number > latest.number)) {
      latest = { number, year };
    }
  }

  const paddedNumber = String(latest.number).padStart(2, '0');
  const pdfUrl =
    `https://www.dpsa.gov.za/dpsa2g/documents/vacancies/${latest.year}/` +
    `PSV%20CIRCULAR%20${paddedNumber}%20of%20${latest.year}.pdf`;
  const sourceUrl = `https://www.dpsa.gov.za/newsroom/psvc/circular-${latest.number}-of-${latest.year}/`;

  return { ...latest, pdfUrl, sourceUrl };
}

// ── 2. Download + parse the PDF (text + link annotations, with page position) ──
async function parsePdf(pdfUrl) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

  const r = await fetch(pdfUrl);
  if (!r.ok) throw new Error(`Could not download circular PDF (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  // One flat array of {type:'text', str, x, y, page} and {type:'link', url, x, y, page}
  // items, in reading order per page (top-to-bottom by y). This lets the
  // vacancy parser walk the document once and match a "CLICK HERE" link
  // annotation to the nearest preceding APPLICATIONS text on the same page.
  const stream = [];
  let fullText = '';

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const y = item.transform ? item.transform[5] : 0;
      const x = item.transform ? item.transform[4] : 0;
      stream.push({ type: 'text', str: item.str, x, y, page: p });
      fullText += item.str + (item.hasEOL ? '\n' : ' ');
    }
    fullText += '\n';

    const annots = await page.getAnnotations();
    for (const a of annots) {
      if (a.subtype === 'Link' && a.url) {
        const y = a.rect ? a.rect[1] : 0;
        const x = a.rect ? a.rect[0] : 0;
        stream.push({ type: 'link', url: a.url, x, y, page: p });
      }
    }
    stream.sort((a, b) => (a.page - b.page) || (b.y - a.y));
  }

  return { fullText, stream, pageCount: doc.numPages };
}

// ── 3. Split the full text into Annexures ──
function splitAnnexures(fullText) {
  const annexureRegex = /ANNEXURE\s+([A-Z]{1,2})\s*\n\s*([^\n]+)/g;
  const markers = [...fullText.matchAll(annexureRegex)];
  const annexures = [];

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const start = m.index;
    const end = i + 1 < markers.length ? markers[i + 1].index : fullText.length;
    const letter = m[1];
    const departmentLine = m[2].trim();
    const isProvincial = PROVINCIAL_ADMINISTRATIONS.some((p) => departmentLine.toUpperCase().includes(p));
    annexures.push({
      annexure: letter,
      department: departmentLine,
      province: isProvincial ? titleCase(departmentLine) : null,
      text: fullText.slice(start, end),
    });
  }
  return annexures;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── 4. Extract one labeled field from a block of text ──
function extractField(text, label) {
  const otherLabels = FIELD_LABELS.filter((l) => l !== label).map((l) => l.replace(/\s+/g, '\\s+'));
  const stopPattern = `(?:${otherLabels.join('|')}|POST\\s+\\d+\\/\\d+|ANNEXURE\\s+[A-Z]|$)`;
  const re = new RegExp(`${label.replace(/\s+/g, '\\s+')}\\s*:\\s*([\\s\\S]*?)(?=${stopPattern})`, 'i');
  const m = text.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// ── 5. Find the application URL for a given text position, via the nearest
//       link annotation on the same page within a reasonable y-distance ──
function findNearbyLink(stream, page, y) {
  let best = null;
  let bestDist = Infinity;
  for (const item of stream) {
    if (item.type !== 'link' || item.page !== page) continue;
    const dist = Math.abs(item.y - y);
    if (dist < bestDist && dist < 40) {
      best = item.url;
      bestDist = dist;
    }
  }
  return best;
}

function resolveApplicationMethod(applicationsText, stream, page, y) {
  if (!applicationsText) return { method: null, url: null };

  const emailMatch = applicationsText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    return { method: 'email', url: null };
  }

  if (/click here|application link/i.test(applicationsText)) {
    const url = findNearbyLink(stream, page, y);
    return { method: url ? 'online_link' : 'unresolved', url: url || null };
  }

  if (/erecruitment|apply online|portal/i.test(applicationsText)) {
    const urlMatch = applicationsText.match(/https?:\/\/\S+/);
    return { method: 'online_portal', url: urlMatch ? urlMatch[0].replace(/[).,]+$/, '') : null };
  }

  if (/private bag|hand deliver|po box/i.test(applicationsText)) {
    return { method: 'postal', url: null };
  }

  return { method: 'unresolved', url: null };
}

// ── 6. Multi-location vacancy detection ──
function splitMultiLocation(centreText) {
  const lineRe = /([A-Za-z][A-Za-z\s]+?)\s*:\s*([A-Za-z\s]+?)\s*Ref\s*No\.?:?\s*([\w\/\-]+)\s*\(X(\d+)\s*Post/gi;
  const matches = [...centreText.matchAll(lineRe)];
  if (matches.length < 2) return null;

  return matches.map((m) => ({
    location: `${m[1].trim()}: ${m[2].trim()}`,
    reference_number: m[3].trim(),
    postCount: parseInt(m[4], 10),
  }));
}

// ── 7. Confidence scoring ──
// Two tiers, deliberately not one flat point count:
//   HARD requirements — without these, the record isn't a trustworthy
//   vacancy at all, regardless of anything else. Missing any of these
//   forces LOW, full stop.
//   SOFT signals — real information that's often present but not always
//   provided by DPSA itself for every post (reference_number, salary,
//   location, and a resolved application URL all fall here). Missing one
//   or two of these is normal and shouldn't block a genuinely well-formed
//   vacancy from being published — reference_number in particular is
//   explicitly NOT treated as mandatory, since some real posts in the
//   source document (confirmed during testing) simply don't carry one.
//   Missing several soft signals AT ONCE is a different story — that's a
//   sign of a genuinely low-quality parse, not just an unusually sparse
//   (but real) listing, so 3+ missing soft signals caps it at LOW too.
function scoreConfidence(v) {
  const warnings = [];

  const hardMissing = [];
  if (!v.title) hardMissing.push('missing title');
  if (!v.department) hardMissing.push('missing department');
  if (!v.closing_date) hardMissing.push('missing closing date');
  if (!v.application_instructions) hardMissing.push('missing application instructions');
  warnings.push(...hardMissing);

  if (hardMissing.length > 0) {
    return { confidence: 'low', warnings };
  }

  let softMissing = 0;
  if (!v.reference_number) { softMissing++; warnings.push('no reference number found (may genuinely not have one)'); }
  if (!v.salary_text) { softMissing++; warnings.push('missing salary'); }
  if (!v.requirements && !v.duties) { softMissing++; warnings.push('missing requirements/duties'); }
  if (!v.location) { softMissing++; warnings.push('missing location'); }
  if (v.application_method === 'unresolved') { softMissing++; warnings.push('application method could not be resolved'); }
  else if (v.application_method === 'online_link' && !v.official_application_url) {
    softMissing++;
    warnings.push('embedded application link could not be confidently matched to this vacancy');
  }

  let confidence;
  if (softMissing === 0) confidence = 'high';
  else if (softMissing <= 2) confidence = 'medium';
  else confidence = 'low';

  return { confidence, warnings };
}

function inferJobCategory(title) {
  const t = title || '';
  if (/\bintern(ship)?\b/i.test(t) && !/\binternational\b/i.test(t)) return 'internship';
  if (/\blearnership\b/i.test(t)) return 'learnership';
  if (/\bgraduate\b/i.test(t)) return 'graduate_programme';
  return 'general';
}

function parseClosingDate(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!m) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = months.indexOf(m[2].toLowerCase());
  if (month === -1) return null;
  const d = new Date(Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10), 23, 59, 0));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── 8. Parse one Annexure's text into vacancy records ──
function parseAnnexure(annexure, circular, stream) {
  const { text, department, province, annexure: letter } = annexure;

  let cleanText = text.replace(
    /ERRATUM[\s\S]*?(?=POST\s+\d+\/\d+|ANNEXURE\s+[A-Z]|$)/gi,
    '\n'
  );

  const postSplitRegex = new RegExp(`POST\\s+${circular.number}\\/(\\d+)\\s*:`, 'g');
  const firstPostMatch = postSplitRegex.exec(cleanText);
  const deptHeaderText = firstPostMatch ? cleanText.slice(0, firstPostMatch.index) : cleanText;

  const deptApplications = extractField(deptHeaderText, 'APPLICATIONS');
  const deptClosingRaw = extractField(deptHeaderText, 'CLOSING DATE');
  const deptClosingDate = parseClosingDate(deptClosingRaw);

  postSplitRegex.lastIndex = 0;
  const postMarkers = [...cleanText.matchAll(postSplitRegex)];

  const vacancies = [];

  for (let i = 0; i < postMarkers.length; i++) {
    const m = postMarkers[i];
    const start = m.index;
    const end = i + 1 < postMarkers.length ? postMarkers[i + 1].index : cleanText.length;
    const postNumber = `${circular.number}/${m[1]}`;
    const block = cleanText.slice(start, end);

    if (ERRATUM_PATTERN.test(block.slice(0, 80))) continue;

    const titleBlockMatch = block.match(
      new RegExp(`POST\\s+${circular.number}\\/${m[1]}\\s*:\\s*([\\s\\S]*?)(?=SALARY|CENTRE|BRANCH|NATURE OF APPOINTMENT|$)`, 'i')
    );
    const titleBlock = titleBlockMatch ? titleBlockMatch[1].replace(/\s+/g, ' ').trim() : '';
    // Most posts write "REF NO: XXX", but some (confirmed in the real
    // Circular 34 text — e.g. POST 34/01) just append a bare code like
    // "DBE/66/2026." with no "REF" label at all. Try the labeled form
    // first; fall back to a bare department-code shape if that's absent,
    // since guessing nothing here would under-report a field that's
    // genuinely present, just unconventionally formatted.
    const refMatch =
      titleBlock.match(/REF\.?\s*(?:NO\.?)?\s*:?\s*([A-Z0-9\/\-\.]{3,})/i) ||
      titleBlock.match(/\b([A-Z]{2,8}\/\d{1,4}\/\d{4})\.?\s*$/);
    const referenceNumber = refMatch ? refMatch[1].replace(/[.,]$/, '') : null;
    const title = titleBlock
      .replace(/REF\.?\s*(?:NO\.?)?\s*:?\s*[A-Z0-9\/\-\.]{3,}.*$/i, '')
      .replace(/\b[A-Z]{2,8}\/\d{1,4}\/\d{4}\.?\s*$/, '')
      .trim();

    const salary = extractField(block, 'SALARY');
    const centre = extractField(block, 'CENTRE');
    const requirements = extractField(block, 'REQUIREMENTS');
    const duties = extractField(block, 'DUTIES');
    const enquiries = extractField(block, 'ENQUIRIES');
    const postApplications = extractField(block, 'APPLICATIONS');
    const postClosingRaw = extractField(block, 'CLOSING DATE');

    const applicationsText = postApplications || deptApplications;
    const closingDate = parseClosingDate(postClosingRaw) || deptClosingDate;

    const appLabelIdx = block.search(/APPLICATIONS\s*:/i);
    const approxOffsetInAnnexure = start + (appLabelIdx >= 0 ? appLabelIdx : 0);
    const nearestStreamItem = findStreamPositionForOffset(stream, annexure, approxOffsetInAnnexure);
    const { method: applicationMethod, url: applicationUrl } = resolveApplicationMethod(
      applicationsText,
      stream,
      nearestStreamItem ? nearestStreamItem.page : 1,
      nearestStreamItem ? nearestStreamItem.y : 0
    );

    const salaryLevelMatch = salary && salary.match(/\((?:Level\s*\d+|OSD)\)/i);

    const baseVacancy = {
      annexure: letter,
      department: titleCase(department),
      province,
      post_number: postNumber,
      title,
      reference_number: referenceNumber,
      salary_text: salary,
      salary_level: salaryLevelMatch ? salaryLevelMatch[0].replace(/[()]/g, '') : null,
      location: centre,
      requirements,
      duties,
      enquiries,
      application_instructions: applicationsText,
      application_method: applicationMethod,
      official_application_url: applicationUrl,
      closing_date: closingDate,
    };

    const multi = centre ? splitMultiLocation(centre) : null;
    if (multi) {
      multi.forEach((loc, idx) => {
        vacancies.push({
          ...baseVacancy,
          location: loc.location,
          reference_number: loc.reference_number,
          source_job_id: `${circular.year}-${circular.number}-${m[1]}-${idx}`,
        });
      });
    } else {
      vacancies.push({
        ...baseVacancy,
        source_job_id: `${circular.year}-${circular.number}-${m[1]}`,
      });
    }
  }

  return vacancies;
}

function findStreamPositionForOffset(stream, annexure, offsetWithinAnnexure) {
  const textItems = stream.filter((s) => s.type === 'text');
  let charsIntoAnnexure = 0;
  let foundAnnexureStart = false;

  for (const item of textItems) {
    if (!foundAnnexureStart) {
      if (item.str.includes('ANNEXURE') && annexure && item.str.includes(annexure.annexure)) {
        foundAnnexureStart = true;
      }
      continue;
    }
    charsIntoAnnexure += item.str.length + 1;
    if (charsIntoAnnexure >= offsetWithinAnnexure) {
      return item;
    }
  }
  return textItems.length ? textItems[textItems.length - 1] : null;
}

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error('dpsa-sync: CRON_SECRET not configured on server');
    return res.status(500).json({ error: 'Server not configured correctly.' });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  let circular;
  try {
    circular = await discoverLatestCircular();
  } catch (e) {
    console.error('dpsa-sync: could not discover latest circular:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not discover latest DPSA circular: ' + e.message });
  }

  try {
    const check = await fetch(
      `${supabaseUrl}/rest/v1/dpsa_sync_log?circular_number=eq.${circular.number}&circular_year=eq.${circular.year}&select=id`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (check.ok) {
      const rows = await check.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return res.status(200).json({ ok: true, message: `Circular ${circular.number} of ${circular.year} already processed.`, circular });
      }
    }
  } catch (e) {
    console.error('dpsa-sync: sync-log check failed, continuing:', e.message);
  }

  let parsed;
  try {
    parsed = await parsePdf(circular.pdfUrl);
  } catch (e) {
    console.error('dpsa-sync: PDF download/parse failed:', e.message);
    await logSyncResult(supabaseUrl, supabaseKey, circular, {
      status: 'failed', error_message: e.message,
    });
    return res.status(502).json({ ok: false, error: 'Could not download or parse the circular PDF: ' + e.message });
  }

  const annexures = splitAnnexures(parsed.fullText);
  let allVacancies = [];
  for (const annexure of annexures) {
    try {
      const vacancies = parseAnnexure(annexure, circular, parsed.stream);
      allVacancies.push(...vacancies);
    } catch (e) {
      console.error(`dpsa-sync: failed to parse Annexure ${annexure.annexure}:`, e.message);
    }
  }

  let published = 0;
  let review = 0;
  let warningCount = 0;
  const now = new Date().toISOString();
  const records = [];

  for (const v of allVacancies) {
    const { confidence, warnings } = scoreConfidence(v);
    warningCount += warnings.length;
    const isPublished = confidence === 'high';
    if (isPublished) published++; else review++;

    records.push({
      source: 'dpsa',
      source_job_id: v.source_job_id,
      government_job: true,
      title: v.title || `Government vacancy ${v.post_number}`,
      company_name: v.department,
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
      job_category: inferJobCategory(v.title),
      salary_text: v.salary_text,
      salary_level: v.salary_level,
      requirements: v.requirements,
      duties: v.duties,
      description: v.duties || v.requirements || null,
      enquiries: v.enquiries,
      application_instructions: v.application_instructions,
      application_method: v.application_method,
      apply_url: v.official_application_url,
      official_application_url: v.official_application_url,
      official_source_url: circular.sourceUrl,
      official_pdf_url: circular.pdfUrl,
      closing_date: v.closing_date,
      confidence_level: confidence,
      review_status: isPublished ? 'published' : 'pending_review',
      is_active: isPublished,
      posted_at: now,
      last_seen_at: now,
      tags: warnings,
    });
  }

  if (records.length > 0) {
    try {
      const upsertRes = await fetch(`${supabaseUrl}/rest/v1/jobs?on_conflict=source,source_job_id`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(records),
      });
      if (!upsertRes.ok) {
        const err = await upsertRes.text();
        console.error('dpsa-sync: upsert failed:', err);
        await logSyncResult(supabaseUrl, supabaseKey, circular, {
          status: 'partial',
          vacancies_detected: allVacancies.length,
          vacancies_published: 0,
          vacancies_review: 0,
          parsing_warnings: warningCount,
          error_message: 'Upsert failed: ' + err,
        });
        return res.status(500).json({ ok: false, error: 'Failed to save vacancies: ' + err });
      }
    } catch (e) {
      console.error('dpsa-sync: upsert threw:', e.message);
      await logSyncResult(supabaseUrl, supabaseKey, circular, { status: 'failed', error_message: e.message });
      return res.status(500).json({ ok: false, error: 'Server error while saving vacancies.' });
    }
  }

  await logSyncResult(supabaseUrl, supabaseKey, circular, {
    status: allVacancies.length > 0 ? 'ok' : 'partial',
    vacancies_detected: allVacancies.length,
    vacancies_published: published,
    vacancies_review: review,
    parsing_warnings: warningCount,
  });

  return res.status(200).json({
    ok: true,
    circular,
    pageCount: parsed.pageCount,
    annexuresFound: annexures.length,
    vacanciesDetected: allVacancies.length,
    published,
    review,
    parsingWarnings: warningCount,
  });
}

async function logSyncResult(supabaseUrl, supabaseKey, circular, fields) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/dpsa_sync_log`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify([
        {
          circular_number: circular.number,
          circular_year: circular.year,
          pdf_url: circular.pdfUrl,
          vacancies_detected: 0,
          vacancies_published: 0,
          vacancies_review: 0,
          vacancies_skipped_erratum: 0,
          parsing_warnings: 0,
          status: 'ok',
          ...fields,
        },
      ]),
    });
  } catch (e) {
    console.error('dpsa-sync: failed to write sync log:', e.message);
  }
}
