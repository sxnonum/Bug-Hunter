# Bug Hunter

[![CI](https://github.com/sxnonum/Bug-Hunter/actions/workflows/ci.yml/badge.svg)](https://github.com/sxnonum/Bug-Hunter/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A fast, zero-dependency static analyzer that hunts for common bugs and risky patterns in JavaScript and TypeScript. It's built to be quiet: it reports a small set of high-signal problems and was tuned against thousands of real-world files so it doesn't cry wolf.

```console
$ node bin/bughunter.js examples
examples/vulnerable.js
  5:7     high   hardcoded-secret          Possible hardcoded credential; load it from the environment or a secret store
  8:3     medium assignment-in-condition   Assignment inside a condition; did you mean ===? (wrap in extra parentheses if intended)
  13:8    high   foreach-async             forEach ignores the promises returned by an async callback; use for...of or Promise.all(map())
  17:3    high   command-injection         Shell command built from dynamic input; use execFile/spawn with an argument array
  21:5    medium empty-catch               Empty catch block swallows errors
  23:9    medium insecure-random           Math.random() is predictable; use crypto.randomBytes() or crypto.randomUUID()
  24:16   low    parseint-radix            parseInt without a radix; pass 10 (or use Number())
  26:12   high   nan-comparison            Nothing equals NaN; use Number.isNaN(value)
  28:5    medium unreachable-code          Unreachable code after statement on line 27
  31:42   high   no-eval                   eval() runs arbitrary code; avoid it

10 findings (5 high, 4 medium, 1 low) in 1 file
```

## Highlights

- **15 rules** covering injection, secrets, async mistakes, dead code and sloppy error handling (see [Rules](#rules)).
- **No dependencies.** Plain Node.js 20+, nothing to install or audit.
- **Understands code, not just text.** A tokenizer-level pass blanks out comments, strings, template text and regex literals, with JSX support, so `"eval(x)"` in a string or a `// TODO` in a URL never trips a rule.
- **CI-ready.** Meaningful exit codes, JSON and [SARIF](https://sarifweb.azurewebsites.net/) output for GitHub code scanning, a config file, and inline suppressions.
- **Tested against reality, not just fixtures.** See [Validation](#validation).

## Quick start

```console
git clone https://github.com/sxnonum/Bug-Hunter.git
cd Bug-Hunter
node bin/bughunter.js path/to/your/project      # or: npm link && bughunter .
```

## Usage

```
node bin/bughunter.js [options] [path...]
```

| Option | Description |
|---|---|
| `--format <text\|json\|sarif>` | Output format (default `text`). `sarif` is SARIF 2.1.0 for code-scanning tools |
| `--min-severity <level>` | Hide findings below `info`, `low`, `medium` or `high` (default `info`). Only affects what is printed, not the exit code |
| `--fail-on <level>` | Exit with code 1 if any finding is at or above this level (default `medium`). Counts every finding, including ones hidden by `--min-severity` |
| `--disable <rules>` | Comma-separated rule ids to skip |
| `--include-minified` | Also scan minified/bundled files, which are skipped by default |
| `--config <path>` | Read options from a JSON file (default: `.bughunterrc.json` in the current directory, if present) |
| `--list-rules` | Print all rules |

Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage error or a file/directory that could not be scanned. `2` takes precedence over `1`, so CI can tell a broken scan from a failing one. Problems are printed to stderr as `bughunter: <file>: <message>` and the remaining files are still scanned.

Scans `.js .mjs .cjs .jsx .ts .mts .cts .tsx` files (case-insensitive), skipping `node_modules`, `.git`, `dist`, `build`, `coverage` and `.next`. Symlinks to files and directories are followed (loops are detected, and a file reachable twice is scanned once, even if you name overlapping paths); a dangling symlink is an error. Some files are skipped and listed under `skipped` in the JSON output, with a note on stderr:

| Reason | When |
|---|---|
| `too-large` | the file is over 1 MB |
| `minified` | the name matches `*.min.js` (also `.mjs`/`.cjs`), or any line is longer than 5000 characters; use `--include-minified` to scan them |
| `binary` | the file contains NUL bytes (this includes UTF-16 files) |
| `not-a-regular-file` | a FIFO, device or similar |

### Config file

`.bughunterrc.json` in the current directory (or the file given with `--config`) sets defaults; command-line flags override it.

```json
{
  "disable": ["todo-marker"],
  "minSeverity": "low",
  "failOn": "high",
  "exclude": ["fixtures", "**/*.generated.js", "lib/legacy/*.js"]
}
```

`exclude` takes plain file or directory names (matched anywhere), or globs relative to each scanned directory, where `*` matches within one path segment, `**` across segments and `?` one character. An excluded directory is skipped whole. Files named explicitly on the command line are always scanned. Unknown keys and invalid values exit with code 2.

### Suppressing a finding

```js
eval(trusted); // bughunter-disable-line no-eval
// bughunter-disable-next-line loose-equality, parseint-radix
```

Leave out the rule ids to suppress every rule on that line.

### GitHub code scanning

`--format sarif` produces a SARIF 2.1.0 report that GitHub can show as annotations on pull requests:

```yaml
- run: node bin/bughunter.js --format sarif --fail-on high src > bughunter.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: bughunter.sarif
```

## Rules

| Rule | Severity | Catches |
|---|---|---|
| `no-eval` | high | `eval()`, indirect `(0, eval)()`, `window.eval`, and `Function()` / `new Function()` with non-constant code |
| `hardcoded-secret` | high | AWS and GitHub (`ghp_`, `github_pat_`) tokens, Slack tokens, private keys, credentials inside URLs, and `password = "..."`-style assignments where the *name* says it's a secret |
| `command-injection` | high | `exec`/`execSync` (and `childProcess.exec`, `execAsync`, ...) with interpolated or concatenated commands |
| `foreach-async` | high | `forEach(async ...)`, whose promises nobody awaits |
| `nan-comparison` | high | `x === NaN` (never true) |
| `tls-verification-disabled` | high | `rejectUnauthorized: false`, `x.rejectUnauthorized = false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `assignment-in-condition` | medium | `if (a = b)` |
| `empty-catch` | medium | `catch {}` and `.catch(() => {})` with no comment explaining why |
| `unreachable-code` | medium | Statements after `return`/`throw`/`break`/`continue`, with or without semicolons |
| `insecure-random` | medium | `Math.random()` used to build tokens, sessions, passwords, salts, etc. |
| `dom-xss` | medium | `innerHTML = ...`, `outerHTML = ...` with non-constant values, `document.write()` |
| `no-debugger` | medium | Leftover `debugger` statements |
| `loose-equality` | low | `==` / `!=` (follows ESLint's `eqeqeq` "smart": `typeof` checks, literals and `== null` / `== undefined` are allowed) |
| `parseint-radix` | low | `parseInt(x)` without a radix |
| `todo-marker` | info | `TODO`, `FIXME`, `HACK`, `XXX` comments |

## Validation

Unit tests on hand-written snippets only prove a tool works on code its author imagined. So Bug Hunter is also checked against real code: the npm CLI, ESLint, TypeScript, Playwright and the rest of their dependency trees, about 2,700 JavaScript and TypeScript files.

- **An independent audit** reproduced 32 problems in the first version (code silently skipped in JSX files, a `hardcoded-secret` rule with **0 true positives in 51 hits**, output cut off at 64 KiB when piped, a regex that took 50 seconds on a hex string). All 32 were fixed and each has a regression test.
- **Noise dropped by more than 90%.** On the same corpus, findings went from 10,385 to 743, and `hardcoded-secret` from 51 hits to 0. The remainder is dominated by the `empty-catch`, `loose-equality` and `todo-marker` style rules.
- **The masker is checked against real parsers.** Its output was compared with token and comment ranges from the `acorn` parser for every plain JavaScript file in the corpus (4,096 files) and against the TypeScript parser for `.ts` files and generated JSX programs.
- **It found a real bug while being tested:** in `http-server`'s `ensureUriEncoded`, a `return text` with no semicolon is followed by a second `return`, so the intended `encodeURIComponent` line never runs.
- **It scans itself.** `npm run scan` runs in CI and must stay at zero findings.

The `acorn` and TypeScript comparisons used throwaway scripts and are not part of the repository's test suite; the corpus numbers are a point-in-time measurement.

## How it works

1. `src/mask.js` is a small lexer. It produces two same-length views of the file, one with comments removed and one with strings, template text and regex bodies removed too, while keeping every offset and line break. It handles nested templates, regex-versus-division ambiguity, TypeScript's non-null `!`, and JSX elements. It uses an explicit stack, so deeply nested input can't overflow the call stack, and it runs in linear time.
2. `src/rules.js` holds the rules. Each is `{ id, severity, description, check(ctx) }` and runs over whichever view suits it.
3. `src/analyze.js` runs the rules, applies inline `bughunter-disable` comments and sorts the findings. `src/scanner.js` walks the file system and `src/report.js` formats the results.

### Limitations

Bug Hunter is a pattern-based analyzer, not a full parser or a data-flow engine. It favours a low false-positive rate on a small set of high-signal checks, so it will miss bugs that need type or data-flow information (for example it does not track whether a variable passed to `exec` is user-controlled). Its lexer is heuristic: the rare construct it can't classify is treated conservatively, and JSX is only recognized where a JSX element can legally start. Use the inline directives when a rule is wrong for your code, and please open an issue with the snippet.

## Development

```console
npm test        # node:test, no dependencies
npm run scan    # the tool scans its own source
```

Adding a rule is a one-entry change plus tests; see [CONTRIBUTING.md](CONTRIBUTING.md).
