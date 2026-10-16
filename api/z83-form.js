// Serves the official, blank, editable Z83 application form.
//
// The form is the DPSA "Editable New Z83 form, effective 1 January 2021".
// A copy of it is stored in this project (uploaded to GitHub), so the Z83
// page no longer has to wait for DPSA's slow website. This route simply
// sends the browser to that copy.
//
// No personal information ever comes to this route: the jobseeker's
// answers are filled into the PDF inside their own browser.

const LOCAL_Z83 = '/editable%20Approved%20New%20Z83%20form%20Gazetted%206%20Nov%202020.pdf';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  res.statusCode = 302;
  res.setHeader('Location', LOCAL_Z83);
  return res.end();
}
