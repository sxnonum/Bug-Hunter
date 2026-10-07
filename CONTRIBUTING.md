# Contributing

Thanks for helping make Bug Hunter better. The project has no runtime dependencies and needs only Node.js 20 or newer.

```
npm test        # unit + CLI tests (node:test)
npm run scan    # Bug Hunter scans its own source; must stay at 0 findings
```

## Adding a rule

1. Add an entry to the `rules` array in `src/rules.js`: `{ id, severity, description, check(ctx) }`.
   Match against the masked views (`codeLines`, `strLines`) so comments and strings don't cause false matches.
2. Add at least one **positive** and one **negative** case to `test/rules.test.js`. Negative cases (code that must *not* be flagged) matter most, because false positives are what make people turn a linter off.
3. Add the rule to the table in `README.md`.
4. Run `npm test && npm run scan`.

## Guidelines

- Prefer a rule that is right 95% of the time on a few high-signal patterns over one that tries to catch everything.
- Keep it dependency-free.
- Don't print secret values in messages.
