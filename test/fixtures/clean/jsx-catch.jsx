'use strict';

// JSX text lines, and a returned chain with a multi-line callback before its empty .catch().
export const Reload = ({ load }) => (
  <div>
    Reload data
    <button onClick={() => { load().catch(console.error); }}>go</button>
  </div>
);

export async function warm(url) {
  return fetch(url).then((res) => {
    cache.set(url, res);
    return res;
  }).catch(() => {});
}
