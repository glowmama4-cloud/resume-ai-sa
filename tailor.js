/* ResumeAI SA — "Tailor my CV for this post"
 *
 * Loaded by index.html. When a jobseeker arrives from the Careers page or
 * the Z83 page with ?tailor=<job id>, this:
 *   1. looks up that job (title, department, reference, requirements, duties),
 *   2. shows a banner "Tailoring your CV for: …" above the CV builder,
 *   3. fills the "Job you are applying for" boxes with the post title,
 *   4. gives the CV and cover-letter prompts the real advert, so the AI
 *      matches the jobseeker's REAL skills to it (never inventing any).
 *
 * The normal CV builder, credits and payments are unchanged: tailoring a CV
 * uses one credit exactly like building any other CV.
 */
/* ── Home page menu on phones ──
 * On small screens the top menu was wider than the phone, so the
 * "Build My CV" button was cut off. This lets the menu buttons wrap onto a
 * second row on phones only. Computers are not affected.
 */
(function mobileNavFix() {
  if (document.getElementById('mobile-nav-fix')) return;
  const s = document.createElement('style');
  s.id = 'mobile-nav-fix';
  s.textContent =
    '@media (max-width: 640px) {' +
    ' nav { height: auto; min-height: 58px; padding: 10px 14px; flex-wrap: wrap; gap: 8px; }' +
    ' .logo { font-size: 18px; }' +
    ' .nav-right { width: 100%; flex-wrap: wrap; gap: 6px; }' +
    ' .nav-right > * { flex: 1 1 auto; text-align: center; justify-content: center; }' +
    ' .nav-btn, .nav-tag { font-size: 12px; padding: 7px 10px; white-space: nowrap; }' +
    '}';
  document.head.appendChild(s);
})();

/* ── Footer: real policy pages + correct support email ── */
(function footerLinks() {
  function apply() {
    const footer = document.querySelector('footer');
    if (!footer) return;
    const pages = { 'privacy policy': '/privacy.html', 'terms of use': '/terms.html', 'refund policy': '/refund.html' };
    footer.querySelectorAll('a').forEach(function (a) {
      const key = a.textContent.trim().toLowerCase();
      if (pages[key]) a.href = pages[key];
      if (/^mailto:/i.test(a.getAttribute('href') || '')) {
        a.href = 'mailto:support@resumeaisa.co.za';
        a.textContent = 'support@resumeaisa.co.za';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();

/* ── Honest Pro plan wording + Pro extras fix ──
 * The Pro plan gives 30 credits that never expire (see api/notify.js), so
 * the price card and paywall now say exactly that instead of "Unlimited".
 * Prices are NOT changed. Every CV, cover letter or LinkedIn bio uses 1
 * credit (the server already works this way).
 *
 * Pro extras (cover letter, LinkedIn bio) used to show only while someone
 * had 10+ credits, so a Pro buyer lost them after using 21 credits. Now
 * they also show for anyone with a completed Pro payment on record.
 */
(function proPlanWording() {
  function apply() {
    const proBtn = document.querySelector('.price-card button[onclick*="buyPlan(\'pro\')"]');
    const card = proBtn && proBtn.closest('.price-card');
    if (card) {
      const note = card.querySelector('.price-currency');
      if (note) note.textContent = 'ZAR · one-time · credits never expire';
      const list = card.querySelector('.price-features');
      if (list) {
        list.innerHTML = '';
        ['30 credits — 1 per CV, cover letter or LinkedIn bio',
         'Tailor a CV to each job you apply for',
         'Cover letter for each application',
         'LinkedIn bio',
         'ATS-friendly format',
         'Credits never expire'].forEach(function (txt) {
          const li = document.createElement('li');
          li.textContent = txt;
          list.appendChild(li);
        });
      }
    }
    // "Multiple job templates" is not a real feature — remove the crossed-out lines
    document.querySelectorAll('.price-features li').forEach(function (li) {
      if (/multiple job templates/i.test(li.textContent)) li.remove();
    });
    const ppPro = document.getElementById('pp-pro');
    if (ppPro) {
      const n = ppPro.querySelector('.pplan-note');
      if (n) n.textContent = 'ZAR · one-time';
      const c = ppPro.querySelector('.pplan-cvs');
      if (c) c.textContent = '30 credits: tailored CVs, cover letters & LinkedIn bio';
    }
    const title = document.querySelector('.pro-extras-title');
    if (title) title.textContent = '✨ Pro Extras — each one uses 1 credit';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();

(function proExtrasFix() {
  const proCache = {};
  async function hasProPurchase() {
    if (typeof currentUser === 'undefined' || !currentUser) return false;
    if (currentUser.id in proCache) return proCache[currentUser.id];
    let found = false;
    try {
      const sb = typeof getSupabase === 'function' ? getSupabase() : null;
      if (sb) {
        const { data, error } = await sb.from('payment_logs')
          .select('id').eq('user_id', currentUser.id).eq('plan', 'pro').limit(1);
        found = !error && Array.isArray(data) && data.length > 0;
      }
    } catch (e) { found = false; }
    proCache[currentUser.id] = found;
    return found;
  }
  window.showProExtras = async function () {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    const box = document.getElementById('pro-extras');
    if (!box) return;
    // Same rule as before (10+ credits) OR a Pro purchase on record
    if ((typeof serverCredits === 'number' && serverCredits >= 10) || await hasProPurchase()) {
      box.classList.remove('hide');
    }
  };
})();

(function () {
  let tailorJob = null;

  function clip(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  function cleanTitle(title) {
    return String(title || '').replace(/\s*REF(?:ERENCE)?\.?\s*NO\.?\s*:?\s*\S+\s*$/i, '').trim();
  }

  /* Extra instructions added to the end of the CV prompt (index.html calls this) */
  window.tailorPromptBlock = function () {
    if (!tailorJob) return '';
    const j = tailorJob;
    const req = clip(j.requirements || j.description, 1800);
    const duties = clip(j.duties, 900);
    return `

TARGET JOB ADVERT — tailor this CV to it:
- Post: ${cleanTitle(j.title)}
- Employer / department: ${j.company_name || j.department || 'not stated'}${j.reference_number ? '\n- Reference number: ' + j.reference_number : ''}${j.government_job ? '\n- This is a South African public service (government) post.' : ''}
- Requirements in the advert: ${req || 'not stated'}
- Duties in the advert: ${duties || 'not stated'}

TAILORING RULES:
- Write the PROFESSIONAL PROFILE for this exact post and employer.
- Put the candidate's REAL skills, experience and qualifications that match these requirements and duties first, and use the advert's own keywords where they truthfully apply.
- NEVER claim a qualification, licence, year of experience, skill or job the candidate did not provide, even if the advert asks for it. If something the advert asks for is missing, simply leave it out.
- Do not mention the reference number or the advert itself inside the CV.`;
  };

  /* Extra instructions for the cover letter (index.html calls this) */
  window.tailorCoverBlock = function () {
    if (!tailorJob) return '';
    const j = tailorJob;
    return `
The cover letter is for this specific post — refer to it by name${j.reference_number ? ' and quote the reference number ' + j.reference_number : ''}, and connect the candidate's real experience to these requirements (never claim anything not in the CV):
- Post: ${cleanTitle(j.title)}
- Employer / department: ${j.company_name || j.department || 'not stated'}
- Requirements: ${clip(j.requirements || j.description, 1200) || 'not stated'}

`;
  };

  function setJobBoxes(title) {
    ['u-job', 'f-job', 'm-job'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el && !el.value.trim()) el.value = title;
    });
  }

  function showBanner(job) {
    const anchor = document.getElementById('path-section');
    if (!anchor) return;
    let box = document.getElementById('tailor-banner');
    if (!box) {
      box = document.createElement('div');
      box.id = 'tailor-banner';
      box.style.cssText = 'background:#e8f5ee;border:1.5px solid #007A4D;border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:14px;color:#005C39;display:flex;gap:12px;align-items:flex-start;justify-content:space-between;';
      anchor.parentNode.insertBefore(box, anchor);
    }
    box.textContent = '';
    const left = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:4px;';
    head.textContent = '🎯 Tailoring your CV for: ' + cleanTitle(job.title);
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;color:#4a4a6a;';
    sub.textContent = (job.company_name || job.department || '') +
      (job.reference_number ? ' · Ref ' + job.reference_number : '') +
      ' — pick a path below. The AI matches your real skills to this advert.';
    left.appendChild(head);
    left.appendChild(sub);
    if (job.government_job) {
      const z = document.createElement('a');
      const p = new URLSearchParams();
      p.set('post', cleanTitle(job.title));
      if (job.department || job.company_name) p.set('dept', job.department || job.company_name);
      if (job.reference_number) p.set('ref', job.reference_number);
      if (job.circular_number) p.set('circular', job.circular_number + ' of ' + job.circular_year);
      z.href = '/z83.html?' + p.toString();
      z.textContent = '📝 Also fill the Z83 for this post';
      z.style.cssText = 'display:inline-block;margin-top:8px;font-size:13px;font-weight:600;color:#005C39;';
      left.appendChild(z);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Stop tailoring to this job');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;color:#4a4a6a;padding:0 4px;';
    close.onclick = function () {
      tailorJob = null;
      box.remove();
      const url = new URL(window.location.href);
      url.searchParams.delete('tailor');
      url.searchParams.delete('job');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    };
    box.appendChild(left);
    box.appendChild(close);
  }

  async function loadTailorJob() {
    const params = new URLSearchParams(window.location.search);
    const id = (params.get('tailor') || '').trim();
    const titleOnly = (params.get('job') || '').trim();

    if (/^[0-9a-f-]{36}$/i.test(id)) {
      try {
        const r = await fetch('/api/jobs?id=' + encodeURIComponent(id));
        const data = await r.json();
        const job = data && data.jobs && data.jobs[0];
        if (job) {
          tailorJob = job;
          setJobBoxes(cleanTitle(job.title));
          showBanner(job);
          return;
        }
      } catch (e) {
        console.warn('Could not load the job to tailor to:', e);
      }
    }
    // Fallback: only a post title was passed (e.g. from the Z83 page)
    if (titleOnly) setJobBoxes(titleOnly.slice(0, 120));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadTailorJob);
  } else {
    loadTailorJob();
  }
})();
