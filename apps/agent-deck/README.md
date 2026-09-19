# Agent Deck dashboard (frontend)

Vite + React UI for the local dashboard (`apps/agent-deck`).

## UI components (shadcn)

`src/components/ui/` holds only wrappers the app imports today. Config lives in `components.json` (aliases for `@/components/ui` and `@/lib/utils`).

To add a missing shadcn block, run from this package directory:

```bash
cd apps/agent-deck
npx shadcn@latest add <component>
```

Install any new peer deps the CLI reports, then commit the generated file under `src/components/ui/`.
