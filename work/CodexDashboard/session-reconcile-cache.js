'use strict';
// Prototype only: caller must advance each file version on every state mutation.
const ledger = require('./request-ledger');
function createCache() {
  let previous = new Map();
  return function reconcile(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const key = JSON.stringify([entry.row.accountId || 'unknown', entry.row.id]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const next = new Map(), records = [], diagnostics = {requests:0, compactions:0, compactionTokens:0, conflicts:0, unresolved:0};
    let rebuilt = 0;
    for (const [key, group] of groups) {
      if (group.some(x => !Number.isSafeInteger(x.version) || x.version < 0)) throw Error('Missing file version');
      const signature = JSON.stringify(group.map(x => [x.path, x.version, x.row]));
      let item = previous.get(key);
      // Mismatched ownership produces a gap ending at the current time.
      // It cannot safely be reused while other sessions advance the snapshot.
      const hasOwnerMismatch = group.some(x => x.state.meta?.id && x.state.meta.id !== x.row.id);
      if (!item || item.signature !== signature || hasOwnerMismatch) {
        const value = ledger.reconcile(group.map(x => [x.row, x.state]));
        item = {signature, value}; rebuilt++;
      }
      next.set(key, item);
      records.push(...item.value.records);
      for (const name of Object.keys(diagnostics)) diagnostics[name] += item.value.diagnostics[name];
    }
    previous = next;
    return {records, diagnostics, rebuilt};
  };
}
module.exports = {createCache};
