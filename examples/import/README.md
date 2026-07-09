# `import` — pass^k over your own results

A five-minute on-ramp: run Maudslay's pass^k reliability math over the trial
results your agent framework already produces, without wiring the two-witness
gate.

```bash
node examples/import/cli.ts my-results.json --out var/import-report.json
```

Input is a `maudslay.external-results/1` file (see
[`../../tests/fixtures/external-results-sample.json`](../../tests/fixtures/external-results-sample.json)
for a complete example). Output is a self-reported import-report and a printed
summary.

**This is a reporter, not the gate.** Self-reported success/failure cannot
witness a silent corruption, so imported reports are labelled
`source: "self-reported"`, `outcomeVerified: false`, and every run prints the
provenance banner. The full adoption guide — including how to map Browser Use
and Skyvern output, and how to move to the real two-witness gate — is in
[`../../docs/ADOPTING.md`](../../docs/ADOPTING.md).

Files:

- [`adapt.ts`](adapt.ts) — pure parse + fail-closed validate + map to the pass^k
  report (reuses the one report builder in `harness/passk.ts`).
- [`cli.ts`](cli.ts) — argv, file I/O, the `runs/` write-guard, and the printed
  summary.
