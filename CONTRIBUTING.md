# Contributing

Thanks for helping make Bug Hunter better. The project has no runtime dependencies and needs only Node.js 20 or newer.

```
npm test        # unit + CLI tests (node:test)
npm run scan    # Bug Hunter scans its own source; CI fails on any finding at medium severity or above
```

## Adding a rule

1. Add an entry to the `rules` array in `src/rules.js`: `{ id, severity, description, check(ctx) }`.
   Pick the view that fits the rule. `ctx.code` / `ctx.codeLines` blank out comments, string and template text and regex bodies, so use them when a match inside a string would be wrong (most rules). `ctx.str` / `ctx.strLines` blank comments and regex bodies but keep string text, for rules that need to read it (secrets, shell commands). `ctx.raw` / `ctx.rawLines` is the untouched source. All views have the same length and line breaks, so `ctx.posOf(offset)` converts an offset in any of them to a line and column.
   `ctx.relFile` is the path relative to the scan root, for rules that treat test files differently.
2. Add at least one **positive** and one **negative** case to `test/rules.test.js`. Negative cases (code that must *not* be flagged) matter most, because false positives are what make people turn a linter off.
3. Add the rule to the table in `README.md`.
4. Run `npm test && npm run scan`.

## Guidelines

- Prefer a rule that is right 95% of the time on a few high-signal patterns over one that tries to catch everything.
- Keep it dependency-free.
- Don't print secret values in messages.
