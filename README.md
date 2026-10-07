# Bug Hunter

A zero-dependency static analyzer that hunts for common bugs and risky patterns in JavaScript and TypeScript. It needs only Node.js 20 or newer.

```
$ node bin/bughunter.js src
src/handler.js
  4:3     medium assignment-in-condition   Assignment inside a condition; did you mean ===? ...
  5:8     high   foreach-async             forEach ignores the promises returned by an async callback ...
  8:31    high   no-eval                   eval() runs arbitrary code; avoid it

3 findings (2 high, 1 medium) in 1 file
```

## Usage

```
node bin/bughunter.js [options] [path...]     # or `bughunter` once installed (npm link / npm i -g .)
```

| Option | Description |
|---|---|
| `--format <text\|json>` | Output format (default `text`) |
| `--min-severity <level>` | Hide findings below `info`, `low`, `medium` or `high` (default `info`) |
| `--fail-on <level>` | Exit with code 1 if any finding is at or above this level (default `medium`) |
| `--disable <rules>` | Comma-separated rule ids to skip |
| `--list-rules` | Print all rules |

Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage error.

Scans `.js .mjs .cjs .jsx .ts .tsx` files, skipping `node_modules`, `.git`, `dist`, `build`, `coverage` and files over 1 MB.

### Suppressing a finding

```js
eval(trusted); // bughunter-disable-line no-eval
// bughunter-disable-next-line loose-equality, parseint-radix
```

Leave out the rule ids to suppress every rule on that line.

## Rules

| Rule | Severity | Catches |
|---|---|---|
| `no-eval` | high | `eval()` and `new Function()` |
| `hardcoded-secret` | high | AWS keys, GitHub/Slack tokens, private keys, `password = "..."` style assignments |
| `command-injection` | high | `exec`/`execSync` with interpolated or concatenated commands |
| `foreach-async` | high | `forEach(async ...)`, whose promises nobody awaits |
| `nan-comparison` | high | `x === NaN` (never true) |
| `tls-verification-disabled` | high | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `assignment-in-condition` | medium | `if (a = b)` |
| `empty-catch` | medium | `catch {}` and `.catch(() => {})` with no comment explaining why |
| `unreachable-code` | medium | Statements after `return`/`throw`/`break`/`continue` |
| `insecure-random` | medium | `Math.random()` for tokens, sessions, passwords, etc. |
| `dom-xss` | medium | `innerHTML =`, `outerHTML =`, `document.write()` |
| `no-debugger` | medium | Leftover `debugger` |
| `loose-equality` | low | `==` / `!=` (the `== null` idiom is allowed) |
| `parseint-radix` | low | `parseInt(x)` without a radix |
| `todo-marker` | info | `TODO`, `FIXME`, `HACK`, `XXX` comments |

## How it works

1. `src/mask.js` makes a pass over the source and blanks out comments, string/template text and regex literals while keeping every character offset and line break. Rules therefore match real code, not the word `eval` inside a string.
2. `src/rules.js` holds the rules. Each is `{ id, severity, description, check(ctx) }` and runs over the masked views.
3. `src/analyze.js` runs the rules, applies inline `bughunter-disable` comments and sorts the findings.

This is a pattern-based analyzer, not a full parser or data-flow engine. It favours low false positives on a small set of high-signal checks, but it can't find everything and may occasionally flag valid code. Use the inline directives when it does.

### Adding a rule

Add an entry to the `rules` array in `src/rules.js`, then add a positive and a negative case to `test/rules.test.js`.

## Development

```
npm test        # node:test, no dependencies
npm run scan    # the tool scans its own source
```
