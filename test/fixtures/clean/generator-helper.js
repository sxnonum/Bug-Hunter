'use strict';

// The shape of tslib's __generator, which uses comma expressions in conditions on purpose.
function step(op, state) {
  var f, y, t, g;
  if (f) throw new TypeError('Generator is already executing.');
  while ((g = { next: verb(0) }), _) {
    try {
      if (((f = 1), y && (t = op[0] & 2 ? y['return'] : op[0] ? y['throw'] || ((t = y['return']) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done)) return t;
      if (((y = 0), t)) op = [op[0] & 2, t.value];
    } catch (e) {
      op = [6, e];
      y = 0;
    }
  }
  return { value: op[0] ? op[1] : void 0, done: true };
}

function legacy(r) {
  var e;
  if (e = r.x, e > 0) return e;
  return 0;
}

module.exports = { step, legacy };
