// Serves the official, blank, editable Z83 application form.
//
// The form itself comes straight from DPSA's website (the "Editable New Z83
// form, effective 1 January 2021"). We only pass it through so that the
// browser on z83.html can fill it in — browsers are not allowed to read a
// file from another website directly.
//
// No personal information ever comes to this route: the jobseeker's
// answers are filled into the PDF inside their own browser.

const Z83_URL =
  'https://www.dpsa.gov.za/dpsa2g/documents/vacancies/editable%20Approved%20New%20Z83%20form%20Gazetted%206%20Nov%202020.pdf';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const r = await fetch(Z83_URL, {
      headers: { 'User-Agent': 'ResumeAI-SA Z83 helper (+https://www.resumeaisa.co.za)' },
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Could not get the Z83 form from DPSA (${r.status}).` });
    }
    const pdf = Buffer.from(await r.arrayBuffer());
    if (pdf.length < 1000 || pdf.slice(0, 4).toString() !== '%PDF') {
      return res.status(502).json({ error: 'DPSA did not return a PDF.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Z83-blank.pdf"');
    // Cache on Vercel's network for a day so DPSA is not asked every time.
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('z83-form:', e.message);
    return res.status(502).json({ error: 'Could not get the Z83 form right now. Please try again.' });
  }
}
