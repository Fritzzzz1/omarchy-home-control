// Bounded request-body reads, split out of server.mjs so it's small and
// independently testable. Behaviour matches upstream voice-chat's inline
// version exactly: buffer chunks, destroy the connection past `limit` rather
// than let an unbounded body exhaust memory, resolve with whatever arrived.
export const readBody = (req, limit = 1e6) => new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { chunks.push(c); size += c.length; if (size > limit) req.destroy(); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
});
