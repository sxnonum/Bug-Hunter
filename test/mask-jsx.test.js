'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask } = require('../src/mask');

const code = (src, opts) => mask(src, opts).code;

test('closing tags and self-closing tags are not regex literals', () => {
  const c = code('const a = <ul><li>{a}</li><li>{eval(b)}</li><br/></ul>;\neval(c);\n');
  assert.ok(c.includes('eval(b)'));
  assert.ok(c.includes('eval(c)'));
});

test('a template literal inside a JSX attribute does not unbalance the file', () => {
  const src = 'const rows = items.map(i => <li key={i.id}><b>{i.name}</b> <Link to={`/items/${i.id}`}>open</Link></li>);\neval(user);\ndebugger;\n';
  const c = code(src);
  assert.ok(c.includes('eval(user)'));
  assert.ok(c.includes('debugger;'));
  assert.ok(c.includes('i.id'));
});

test('JSX text with quotes, // , /* and backticks is blanked in code and kept in withStrings', () => {
  for (const text of ["Don't forget", 'See http://example.com', 'glob src/*.js', 'it`s', 'a "quote" b', '*/ weird /*']) {
    const src = `const a = <p>${text} {eval(x)}</p>;\neval(user);\n/* c */\ndebugger;\n`;
    const r = mask(src);
    assert.ok(r.code.includes('eval(x)'), text);
    assert.ok(r.code.includes('eval(user)'), text);
    assert.ok(r.code.includes('debugger;'), text);
    assert.ok(!r.code.includes(text), text);
    assert.ok(r.withStrings.includes(text), text);
    assert.ok(!r.code.includes('/* c */'), text);
  }
});

test('fragments, member and namespaced names, nested elements', () => {
  const src = 'x = <><A.B c-d="1"><x-y:z>t\'</x-y:z></A.B>{a}</>; eval(u);';
  const c = code(src);
  assert.ok(c.includes('eval(u)'));
  assert.ok(c.includes('c-d='));
  assert.ok(!c.includes("t'"));
});

test('attribute strings are strings, attribute expressions are code', () => {
  const r = mask('x = <a title="eval(x) > </a>" href=\'y\' onClick={eval(y)} {...rest} disabled />; eval(z);');
  assert.ok(!r.code.includes('eval(x)'));
  assert.ok(r.withStrings.includes('eval(x)'));
  assert.ok(r.code.includes('eval(y)'));
  assert.ok(r.code.includes('eval(z)'));
});

test('JSX comments are comments', () => {
  const r = mask("x = <div>{/* eval(a) ' */}{y}</div>; eval(b);");
  assert.ok(!r.code.includes('eval(a)'));
  assert.ok(!r.withStrings.includes('eval(a)'));
  assert.ok(r.code.includes('eval(b)'));
});

test('JSX inside expressions inside JSX', () => {
  const src = 'x = <ul>{items.map(i => <li key={i}>{i > 1 ? <b>it\'s</b> : `t${<i>q`</i>}`}</li>)}</ul>; eval(u);';
  const c = code(src);
  assert.ok(c.includes('eval(u)'));
  assert.ok(c.includes('i > 1'));
});

test('regex and division still work inside JSX expressions', () => {
  const c = code("x = <a b={/'/.test(s)} c={n / 2 / 3}>{if0 ? 1 : 2}</a>; eval(u);");
  assert.ok(!c.includes("'"));
  assert.ok(c.includes('n / 2 / 3'));
  assert.ok(c.includes('eval(u)'));
});

test('JSX is recognised after return, arrow, ternary and &&', () => {
  for (const pre of ['return', 'x = a ? ', 'x = a && ', 'f(', 'x = () =>', 'x = [', 'x = a ? b :']) {
    const c = code(`${pre} <p>it's // here</p>; eval(u);`);
    assert.ok(c.includes('eval(u)'), pre);
  }
});

test('TS generic arrows and comparisons are not JSX', () => {
  for (const generic of ['<T,>(x: T) => x', '<T extends object>(x: T) => x', '<T>(x: T) => x', '<T extends X<Y>, U = 1>(x: T) => x']) {
    const src = `const f = ${generic};\nconst y = a < b;\nconst z = c / d / e;\neval(u);\n`;
    const c = code(src);
    assert.equal(c.replace(/ +/g, ' '), src.replace(/ +/g, ' '), generic);
  }
  const cmp = 'if (a <b && c> d) eval(1); x = a / b / c;';
  assert.equal(code(cmp), cmp);
});

test('a malformed element falls back to normal lexing without blanking outside it', () => {
  for (const src of [
    'x = <div>\neval(u);\n',
    'x = <a><b></a>; eval(u);',
    'x = <a b=>; eval(u);',
    'x = <a b={; eval(u);',
    'x = <a b="\neval(u);',
    'x = <a>{ ; eval(u);',
    'x = <a></b>; eval(u);',
    'x = <; eval(u);',
  ]) {
    const c = code(src);
    assert.ok(c.includes('eval(u)'), src);
    assert.equal(c.length, src.length);
  }
});

test('with jsx: false, < is never an element', () => {
  const src = "x = <T>y; z = <p>it's {eval(a)}</p>;\neval(b);\n";
  const c = code(src, { jsx: false });
  assert.ok(c.includes('eval(b)'));
  assert.ok(c.includes('<T>y'));
  assert.ok(c.includes('<p>it'));
});

test('very deep JSX nesting does not overflow the stack', () => {
  const d = 30000;
  const src = 'x = ' + '<a>'.repeat(d) + 'hi' + '</a>'.repeat(d) + ';\neval(u);\n';
  const c = code(src);
  assert.ok(c.includes('eval(u)'));
  assert.ok(!c.includes('hi'));
  const exprs = 'x = ' + '<a>{'.repeat(d) + '1' + '}</a>'.repeat(d) + ';\neval(u);\n';
  assert.ok(code(exprs).includes('eval(u)'));
});

test('many failed JSX attempts stay linear', () => {
  const src = 'const f = <T extends object>(a: T) => a;\n'.repeat(20000);
  const t = process.hrtime.bigint();
  mask(src);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 2000);
  const t2 = process.hrtime.bigint();
  mask('x = <a>{'.repeat(40000));
  assert.ok(Number(process.hrtime.bigint() - t2) / 1e6 < 2000);
});

test('TSX type arguments after the element name are part of the tag', () => {
  for (const open of ['<Table<Row> rows={rows}>', '<Select<Option, string> a="b">', '<A<B<C>> x>', '<Map<string, Array<number>>>', "<Pick<T, 'a' | 'b'>>", '<F<(x: number) => void>>']) {
    const name = open.slice(1).split(/[<> ]/)[0];
    const src = `const a = (\n  ${open}\n    <p>Don't call eval(x) here</p>\n  </${name}>\n);\neval(user);\n`;
    const c = code(src, { jsx: true });
    assert.ok(!c.includes('eval(x)'), open);
    assert.ok(c.includes('eval(user)'), open);
  }
  const c = code("const a = <Table<Row> rows={rows}><p>Don't {eval(x)}</p></Table>;\n");
  assert.ok(c.includes('eval(x)'));
});

test('a comparison is still not a type-argument list', () => {
  const c = code('const ok = a < b && c > d;\nconst z = x < y > (1);\neval(q);\n');
  assert.equal(c, 'const ok = a < b && c > d;\nconst z = x < y > (1);\neval(q);\n');
});

test('type arguments that are not a list fail the element instead of eating the file', () => {
  const c = code('const a = <A<b + c>>x</A>;\neval(user);\n');
  assert.ok(c.includes('eval(user)'));
});

test('generic arrows and function types do not use up the JSX budget', () => {
  let src = '';
  for (let i = 0; i < 40; i++) src += `export const id${i} = <T extends object>(x: T): T => x;\n`;
  for (let i = 0; i < 40; i++) src += `export type Fn${i} = <T>(x: T) => T;\n`;
  for (let i = 0; i < 1200; i++) src += `export function C${i}() {\n  return <p>Never call eval(x) here</p>;\n}\n`;
  src += 'eval(user);\n';
  const c = code(src);
  assert.ok(!c.includes('eval(x)'));
  assert.ok(c.includes('eval(user)'));
  assert.equal(c.split('eval(user)').length, 2);
});

test('generic arrows are rejected even when a closing tag of that name exists later', () => {
  const src = "const id = <T extends object>(x: T): T => x;\nconst a = <T>text 'it</T>;\neval(user);\n";
  const c = code(src);
  assert.ok(c.includes('<T extends object>(x: T): T => x;'));
  assert.ok(!c.includes('text'));
  assert.ok(c.includes('eval(user)'));
});

test('JSX text that starts with parentheses is still JSX', () => {
  for (const text of ['(optional) eval(x)', '(a) and (b) eval(x)', '(see below): eval(x)']) {
    const c = code(`const a = <Hint>${text}</Hint>;\neval(user);\n`);
    assert.ok(!c.includes('eval(x)'), text);
    assert.ok(c.includes('eval(user)'), text);
  }
});

test('JSX may follow `export default`', () => {
  const c = code("export default <p>Don't call eval(x) here</p>;\neval(user);\n");
  assert.ok(!c.includes('eval(x)'));
  assert.ok(c.includes('eval(user)'));
  assert.ok(code("export default <></>;\neval(user);\n").includes('eval(user)'));
});
