'use strict';

// Environment sniffing written the pre-ES6 way: comparisons that cannot coerce anything.
var root = typeof window == 'undefined' ? global : window;
var hasModule = typeof module != 'undefined' && module.exports;
var hasProcess = 'undefined' != typeof process;

function isFn(x) {
  return typeof x == 'function';
}

function same(a, b) {
  return typeof a == typeof b;
}

function missing(x) {
  return x == undefined || x === void 0 || x == null;
}

function literals() {
  return 1 == 1 && 'a' != 'b';
}

module.exports = { root, hasModule, hasProcess, isFn, same, missing, literals };
