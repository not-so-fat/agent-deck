# RSI feedback smoke

This is the first deliberately small configuration of `agent-deck experiment`.
It turns two real feedback signals into deterministic cases and compares frozen
baseline/candidate observations.

It proves the data path, not that the candidate skill is scientifically better.
The included observations are sanitized historical examples. Replace them with
outputs from matched Agent Deck runs before treating the result as evidence.

Run:

```bash
npm run agent-deck:dev -- experiment evaluate \
  docs/examples/experiments/rsi-feedback-smoke/experiment.json
```

The experiment intentionally has no optimizer or automatic promotion. Candidate
generation, live runs, and human acceptance remain outside the evaluator.
