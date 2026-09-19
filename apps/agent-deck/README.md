# Agent Deck dashboard (frontend)

Vite + React UI for the local dashboard (`apps/agent-deck`).

## UI components (shadcn)

`src/components/ui/` holds only wrappers the app imports today. To add a missing shadcn block:

```bash
npx shadcn@latest add <component>
```

Run from this package (or the monorepo root with the correct `-c` / components path if configured). Install any new peer deps the CLI reports, then commit the generated file under `src/components/ui/`.
