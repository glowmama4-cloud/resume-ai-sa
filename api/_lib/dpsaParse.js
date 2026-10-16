// Turns the text of a DPSA Public Service Vacancy Circular (or one of its
// per-department annexure PDFs) into individual vacancy records.
//
// Pure functions only: no network, no database. dpsa-sync.js downloads the
// PDFs and saves the results; this file only reads text. Nothing is ever
// guessed: a field that cannot be found stays null and lowers the record's
// confidence instead.

const FIELD_LABELS = [
  'SALARY',
  'STIPEND',
  'CENTRE',
  'REQUIREMENTS',
  'DUTIES',
  'ENQUIRIES',
  'APPLICATIONS',
  'FOR ATTENTION',
  'NOTE',
  'CLOSING DATE',
];

const PROVINCES = [
  ['Eastern Cape', /EASTERN CAPE/i],
  ['Free State', /FREE STATE/i],
  ['Gauteng', /GAUTENG/i],
  ['KwaZulu-Natal', /KWAZULU[\s-]*NATAL/i],
  ['Limpopo', /LIMPOPO/i],
  ['Mpumalanga', /MPUMALANGA/i],
  ['North West', /NORTH[\s-]*WEST/i],
  ['Northern Cape', /NORTHERN CAPE/i],
  ['Western Cape', /WESTERN CAPE/i],
];

// Well-known towns, used ONLY to fill in a province when the centre text
// names exactly one province's towns. Ambiguous text stays null.
const TOWN_PROVINCE = [
  ['Gauteng', /\b(Pretoria|Tshwane|Johannesburg|Soweto|Centurion|Midrand|Germiston|Benoni|Boksburg|Vereeniging|Vanderbijlpark|Krugersdorp|Randburg|Sandton|Ekurhuleni)\b/i],
  ['Western Cape', /\b(Cape Town|Bellville|Stellenbosch|George|Paarl|Worcester|Mossel Bay|Oudtshoorn|Khayelitsha|Mitchells Plain)\b/i],
  ['KwaZulu-Natal', /\b(Durban|eThekwini|Pietermaritzburg|Richards Bay|Newcastle|Ulundi|Ladysmith|Port Shepstone|Empangeni)\b/i],
  ['Eastern Cape', /\b(Gqeberha|Port Elizabeth|East London|Bhisho|Bisho|Mthatha|Qonce|King William'?s Town|Makhanda|Grahamstown|Komani|Queenstown)\b/i],
  ['Free State', /\b(Bloemfontein|Welkom|Bethlehem|Kroonstad|Sasolburg|Phuthaditjhaba)\b/i],
  ['Limpopo', /\b(Polokwane|Thohoyandou|Tzaneen|Mokopane|Lebowakgomo|Giyani|Musina)\b/i],
  ['Mpumalanga', /\b(Mbombela|Nelspruit|Emalahleni|Witbank|Middelburg|Secunda|Ermelo|KwaMhlanga)\b/i],
  ['North West', /\b(Mahikeng|Mafikeng|Mmabatho|Rustenburg|Potchefstroom|Klerksdorp|Brits|Vryburg)\b/i],
  ['Northern Cape', /\b(Kimberley|Upington|Kuruman|Springbok|De Aar)\b/i],
];

const ERRATUM_PATTERN = /\b(ERRATUM|WITHDRAWN|WITHDRAWAL|CORRECTION|AMENDMENT)\b/i;

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const SMALL_WORDS = new Set(['of', 'and', 'the', 'for', 'in', 'on', 'to', 'at', 'a', 'an']);

export function titleCase(s) {
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => {
      if (!w.trim()) return w;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      // keep bracketed acronyms like (DOA) / (GDHS) in capitals
      if (/^\(?[a-z]{2,6}\)?$/.test(w) && /^\(.*\)$/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

function cleanSpaces(s) {
  return s ? s.replace(/\s+/g, ' ').trim() : s;
}

// "Centre" -> "[Cc][Ee][Nn][Tt][Rr][Ee]" (case-insensitive piece inside a
// case-sensitive regex)
function anyCase(label) {
  return label
    .split('')
    .map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch === ' ' ? '\\s+' : ch))
    .join('');
}

// One labelled field (e.g. "SALARY : R..."), stopping at the next label.
// The next label only counts when written in CAPITALS (the circular's
// format) or when it starts a new line — so ordinary words such as
// "Mavambe Secure Care Centre: Private Bag ..." do not cut a field short.
export function extractField(text, label) {
  const others = FIELD_LABELS.filter((l) => l !== label);
  const upper = others.map((l) => l.replace(/\s+/g, '\\s+')).join('|');
  const lineStart = others.map(anyCase).join('|');
  const stop = `(?:\\b(?:${upper})\\s*:|\\n[ \\t]*(?:${lineStart})\\s*:|POST\\s+\\d+\\/\\d+|ANNEXURE\\s+[A-Z]{1,2}\\s*\\n|$)`;
  const re = new RegExp(`\\b${anyCase(label)}\\s*:\\s*([\\s\\S]*?)(?=${stop})`);
  const m = text.match(re);
  const v = m ? cleanSpaces(m[1]) : null;
  return v || null;
}

export function parseClosingDate(text) {
  if (!text) return null;
  let m = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  let y, mo, d;
  if (m) {
    d = parseInt(m[1], 10);
    mo = MONTHS.indexOf(m[2].toLowerCase());
    y = parseInt(m[3], 10);
  } else {
    m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (!m) return null;
    d = parseInt(m[1], 10);
    mo = parseInt(m[2], 10) - 1;
    y = parseInt(m[3], 10);
  }
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  // 23:59 South African time (UTC+2) on the closing day
  const date = new Date(Date.UTC(y, mo, d, 21, 59, 0));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function normaliseUrl(u) {
  if (!u) return null;
  let url = u.replace(/[).,;:'"\]]+$/, '');
  if (/^www\./i.test(url)) url = 'https://' + url;
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) return null;
  return url;
}

// How does a jobseeker apply? Returns { method, url, email }.
export function resolveApplicationMethod(text, linkUrl) {
  if (!text) return { method: null, url: null, email: null };

  const emailMatch = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const email = emailMatch ? emailMatch[0].replace(/\.$/, '') : null;
  // full links, www. links, or bare South African domains such as
  // "erecruitment.mpg.gov.za" (an e-mail address is never treated as a link)
  const urlMatch =
    text.match(/\b(?:https?:\/\/|www\.)[^\s,;<>]+/i) ||
    text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
      .match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:gov|org|co|ac)\.za(?:\/[^\s,;<>]*)?/i);
  const url = urlMatch ? normaliseUrl(/^(https?:\/\/|www\.)/i.test(urlMatch[0]) ? urlMatch[0] : 'https://' + urlMatch[0]) : null;

  if (/click here|application link|following link/i.test(text) && linkUrl) {
    return { method: 'online_link', url: linkUrl, email };
  }
  if (url && /online|e-?recruit|portal|apply|submit|website|jobs/i.test(text)) {
    return { method: 'online_portal', url, email };
  }
  if (email) return { method: 'email', url: null, email };
  if (url) return { method: 'online_portal', url, email: null };
  if (/private bag|hand[\s-]*deliver|p\.?\s*o\.?\s*box|courier|posted to|post to|delivered to|drop(?:ped)? off/i.test(text)) {
    return { method: 'postal', url: null, email: null };
  }
  return { method: 'unresolved', url: null, email: null };
}

function provinceFrom(text) {
  if (!text) return null;
  const hits = PROVINCES.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  const towns = TOWN_PROVINCE.filter(([, re]) => re.test(text)).map(([name]) => name);
  return towns.length === 1 ? towns[0] : null;
}

function inferJobCategory(title) {
  const t = title || '';
  if (/\bintern(s|ship)?\b/i.test(t) && !/\binternal\b|\binternational\b/i.test(t)) return 'internship';
  if (/\blearnership\b/i.test(t)) return 'learnership';
  if (/\bgraduate\b/i.test(t)) return 'graduate_programme';
  return 'general';
}

// Sub-department headings inside one annexure. Provincial annexures (e.g.
// Western Cape, KwaZulu-Natal) contain several departments, each with its
// own APPLICATIONS / CLOSING DATE instructions. A heading counts when the
// text after it (before the next POST) carries such an instruction, or —
// in a provincial annexure only — when it is a "DEPARTMENT OF ..." line.
const SECTION_RE = /\n[ \t]*((?:DEPARTMENT OF|OFFICE OF THE PREMIER|PROVINCIAL TREASURY|PROVINCIAL PARLIAMENT|WESTERN CAPE|GAUTENG|KWAZULU|LIMPOPO|MPUMALANGA|FREE STATE|NORTH WEST|NORTHERN CAPE|EASTERN CAPE)[A-Z0-9 ,&'’:\-()\/]{0,90}?)[ \t]*\n/g;

function findSections(text, postRe, provincial) {
  const sections = [];
  for (const m of text.matchAll(SECTION_RE)) {
    const after = text.slice(m.index + m[0].length);
    postRe.lastIndex = 0;
    const next = after.search(postRe);
    if (next === -1 || next > 20000) continue;
    const name = cleanSpaces(m[1]);
    const hasInstructions = /\b(APPLICATIONS|CLOSING DATE|FOR ATTENTION)\s*:/i.test(after.slice(0, next));
    if (hasInstructions || (provincial && /^DEPARTMENT OF\b/.test(name))) {
      sections.push({ index: m.index, name });
    }
  }
  return sections;
}

// Split text into annexures: "ANNEXURE A \n DEPARTMENT OF ...".
export function splitAnnexures(fullText) {
  const markers = [...fullText.matchAll(/ANNEXURE\s+([A-Z]{1,2})\s*\n\s*([^\n]+)/g)];
  return markers.map((m, i) => ({
    letter: m[1],
    heading: cleanSpaces(m[2]),
    start: m.index,
    end: i + 1 < markers.length ? markers[i + 1].index : fullText.length,
  }));
}

// Main entry point.
//   fullText  – text of the PDF
//   circular  – { number, year }
//   opts.linkAt(offset) – optional: returns the PDF link annotation nearest
//                         to that character offset (for "click here" links)
export function parseVacancies(fullText, circular, opts = {}) {
  const linkAt = opts.linkAt || (() => null);
  const results = [];
  const n = circular.number;

  for (const ann of splitAnnexures(fullText)) {
    const annText = fullText.slice(ann.start, ann.end);
    const annProvince = /PROVINCIAL ADMINISTRATION/i.test(ann.heading) ? provinceFrom(ann.heading) : null;

    const postRe = new RegExp(`POST\\s+${n}\\/(\\d+)\\s*:`, 'g');
    const posts = [...annText.matchAll(postRe)];
    if (posts.length === 0) continue;

    const sections = findSections(annText, new RegExp(`POST\\s+${n}\\/\\d+\\s*:`, 'g'), Boolean(annProvince));

    // Header instructions that apply to the whole annexure.
    const annHeader = annText.slice(0, posts[0].index);
    const annApplications = extractField(annHeader, 'APPLICATIONS');
    const annClosing = parseClosingDate(extractField(annHeader, 'CLOSING DATE'));

    // Header instructions per section.
    const sectionInfo = sections.map((s) => {
      postRe.lastIndex = 0;
      const rest = annText.slice(s.index);
      const firstPost = rest.search(new RegExp(`POST\\s+${n}\\/\\d+\\s*:`));
      const head = rest.slice(0, firstPost === -1 ? rest.length : firstPost);
      return {
        ...s,
        applications: extractField(head, 'APPLICATIONS'),
        closing: parseClosingDate(extractField(head, 'CLOSING DATE')),
      };
    });

    for (let i = 0; i < posts.length; i++) {
      const m = posts[i];
      const start = m.index;
      let end = i + 1 < posts.length ? posts[i + 1].index : annText.length;
      // a post's own text ends where the next section heading begins
      for (const s of sectionInfo) {
        if (s.index > start && s.index < end) { end = s.index; break; }
      }
      const block = annText.slice(start, end);
      if (ERRATUM_PATTERN.test(block.slice(0, 100))) continue;

      // Which section governs this post? (the last heading before it)
      let section = null;
      for (const s of sectionInfo) if (s.index < start) section = s;

      // ── Title and reference number ──
      const titleRaw = (block.match(
        new RegExp(`POST\\s+${n}\\/${m[1]}\\s*:\\s*([\\s\\S]*?)(?=\\b(?:SALARY|STIPEND|CENTRE|NATURE OF APPOINTMENT)\\s*:|$)`, 'i')
      ) || [])[1] || '';
      const titleFlat = cleanSpaces(titleRaw);
      const referenceNumber = extractReference(titleFlat);

      const lines = titleRaw.split('\n').map((l) => l.trim()).filter(Boolean);
      const titleLines = [];
      for (const l of lines) {
        const beforeRef = l.split(/\bREF(?:ERENCE)?\.?\s*(?:NO|NUMBER)?\.?\s*:/i)[0];
        if (titleLines.length && /[a-z]/.test(beforeRef)) break; // "Directorate: ..." lines are mixed case
        titleLines.push(beforeRef);
        if (beforeRef !== l) break; // reached "REF NO"
      }
      const title = cleanSpaces(titleLines.join(' '))
        .replace(/\b[A-Z]{2,10}\/\d{1,4}\/\d{4}\.?\s*$/, '')
        .replace(/\(\s*X\s*\d+\s*POSTS?\s*\)/ig, '')
        .replace(/[\s:–-]+$/, '')
        .trim();

      // ── Fields ──
      const salary = extractField(block, 'SALARY') || extractField(block, 'STIPEND');
      const centre = extractField(block, 'CENTRE');
      const requirements = extractField(block, 'REQUIREMENTS');
      const duties = extractField(block, 'DUTIES');
      const enquiries = extractField(block, 'ENQUIRIES');
      const ownApplications = extractField(block, 'APPLICATIONS');
      const applications = ownApplications || (section && section.applications) || annApplications;
      const closingDate =
        parseClosingDate(extractField(block, 'CLOSING DATE')) ||
        (section && section.closing) ||
        annClosing;

      const appOffset = ownApplications
        ? ann.start + start + block.search(/APPLICATIONS\s*:/i)
        : null;
      const app = resolveApplicationMethod(applications, appOffset != null ? linkAt(appOffset) : null);

      const salaryLevel = salary ? ((salary.match(/\(\s*(Level\s*\d+|OSD)\s*\)/i) || [])[1] || null) : null;
      const department = titleCase(section ? section.name : ann.heading.replace(/^PROVINCIAL ADMINISTRATION:\s*/i, ''));
      const province = annProvince || provinceFrom(centre);

      const base = {
        annexure: ann.letter,
        department,
        company_name: annProvince && !department.toLowerCase().includes(annProvince.toLowerCase())
          ? `${department} (${annProvince})`
          : department,
        province,
        post_number: `${n}/${m[1]}`,
        title: title || null,
        reference_number: referenceNumber,
        salary_text: salary,
        salary_level: salaryLevel,
        location: centre,
        requirements,
        duties,
        enquiries,
        application_instructions: applications,
        application_method: app.method,
        official_application_url: app.url,
        closing_date: closingDate,
        job_category: inferJobCategory(title),
        source_job_id: `${circular.year}-${n}-${m[1]}`,
      };

      // One advert, several centres each with its own reference number
      const multi = centre ? splitMultiLocation(centre) : null;
      if (multi) {
        multi.forEach((loc, idx) => {
          results.push(score({
            ...base,
            location: loc.location,
            province: provinceFrom(loc.location) || base.province,
            reference_number: loc.reference_number,
            source_job_id: `${base.source_job_id}-${idx}`,
          }));
        });
      } else {
        results.push(score(base));
      }
    }
  }
  return results;
}

// "REF NO: FMTE 02/10/2026 (X1 POST)" -> "FMTE 02/10/2026".
// First token is taken as-is; later tokens only if they contain a digit or
// a slash, so ordinary words after the reference are never swallowed.
export function extractReference(text) {
  if (!text) return null;
  const label = text.match(/\bREF(?:ERENCE)?\.?\s*(?:NO|NUMBER)?\.?\s*:?\s*/i);
  if (label) {
    const rest = text.slice(label.index + label[0].length).split(/\s+/);
    const tokens = [];
    for (const raw of rest) {
      const tok = raw.replace(/[.,;:]+$/, '');
      if (!tok || tok.startsWith('(')) break;
      if (!/^[A-Za-z0-9\/\-\.&_]+$/.test(tok)) break;
      // later pieces must look like part of a reference ("02/10/2026", "2026"),
      // so words like "Re-Advertisement" or "R1" are left out
      if (tokens.length && !(/\d/.test(tok) && (/\//.test(tok) || /^\d+$/.test(tok)))) break;
      tokens.push(tok);
      if (raw !== tok) break; // trailing punctuation ends the reference
    }
    const ref = tokens.join(' ');
    if (ref.length >= 3) return ref;
  }
  const bare = text.match(/\b([A-Z]{2,10}\/\d{1,4}\/\d{4})\b/);
  return bare ? bare[1] : null;
}

function splitMultiLocation(centreText) {
  const re = /([A-Za-z][A-Za-z\s]+?)\s*:\s*([A-Za-z\s]+?)\s*Ref\s*No\.?:?\s*([\w\/\-]+)\s*\(X(\d+)\s*Post/gi;
  const matches = [...centreText.matchAll(re)];
  if (matches.length < 2) return null;
  return matches.map((m) => ({
    location: `${m[1].trim()}: ${m[2].trim()}`,
    reference_number: m[3].trim(),
  }));
}

// HIGH and MEDIUM are real, complete-enough adverts and are published.
// LOW (something essential missing) goes to the admin review queue.
function score(v) {
  const warnings = [];
  const hard = [];
  if (!v.title) hard.push('missing title');
  if (!v.department) hard.push('missing department');
  if (!v.closing_date) hard.push('missing closing date');
  if (!v.application_instructions) hard.push('missing application instructions');
  warnings.push(...hard);

  let confidence;
  if (hard.length) {
    confidence = 'low';
  } else {
    let soft = 0;
    if (!v.reference_number) { soft++; warnings.push('no reference number found'); }
    if (!v.salary_text) { soft++; warnings.push('missing salary'); }
    if (!v.requirements && !v.duties) { soft++; warnings.push('missing requirements/duties'); }
    if (!v.location) { soft++; warnings.push('missing location'); }
    if (v.application_method === 'unresolved') { soft++; warnings.push('application method not found'); }
    confidence = soft === 0 ? 'high' : soft <= 2 ? 'medium' : 'low';
  }
  return { ...v, confidence, warnings };
}
