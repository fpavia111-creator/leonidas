'use strict';
/** Child process used by the synchronous send loop: reads {smtp, envelope, eml} JSON on stdin, prints a JSON result. */
const { sendMail } = require('./smtp');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const { smtp, envelope, eml } = JSON.parse(input);
    const r = await sendMail(smtp, eml, envelope);
    process.stdout.write(JSON.stringify({ ok: true, ...r }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code || null, stage: e.stage || null, permanent: !!(e.code >= 500 && e.code < 600) }));
  }
});
