// A small Express-style handler with the kind of bugs Bug Hunter is built to catch.
// Run:  node bin/bughunter.js examples
const { exec } = require('node:child_process');

const dbPassword = 'Sup3rS3cret!pw';

async function handler(req, res, items) {
  if (req.user = null) {
    return res.status(401).end();
  }

  // Looks like it waits for every save, but forEach ignores the promises.
  items.forEach(async (item) => {
    await save(item);
  });

  exec(`convert ${req.query.file} out.png`);

  try {
    await audit(req);
  } catch (err) {}

  const sessionId = Math.random().toString(36).slice(2);
  const page = parseInt(req.query.page);

  if (page === NaN) {
    return res.status(400).end();
    log('rejected bad page');
  }

  return res.json({ sessionId, page, ok: eval(req.body.expression) });
}

module.exports = { handler, dbPassword };
