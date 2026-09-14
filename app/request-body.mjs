// Bounded request-body reads, split out of server.mjs so it's small and independently testable:
// buffer chunks, and destroy the connection past `limit` rather than let an unbounded body exhaust
// memory. Rejects when the body is too large or the request is cut off before it ends, so a caller
// never waits for an 'end' that will not come.
export const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { chunks.push(c); size += c.length; if (size > limit) { req.destroy(); reject(new Error('request body too large')); } });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('close', () => { if (!req.complete) reject(new Error('request closed before its body ended')); });
});
