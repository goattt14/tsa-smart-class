# TSA — Smart Class Management & AI Personalised Learning Platform

Monorepo for The Scholastic Academy. React SPA on Vercel, Express API on Render,
PostgreSQL on Neon with pgvector for retrieval-augmented question generation.

```
apps/
  api/   Node 20 + Express 4 + TypeScript + Prisma
  web/   Vite + React 18 + TypeScript + Tailwind
docs/    architecture, API and deployment notes
scripts/ operational helpers
```

## Local setup

```bash
cp .env.example apps/api/.env      # fill DATABASE_URL and the JWT secrets
cp apps/web/.env.example apps/web/.env

docker compose up -d postgres      # or point DATABASE_URL at Neon
npm install
npm run db:migrate                 # creates the schema
npm run db:seed                    # branding + self-study policy
npm run dev                        # API on :4000, web on :5173
```

Open http://localhost:5173/status to confirm the API and database are reachable.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs API and web together |
| `npm run build` | Builds both workspaces |
| `npm run db:migrate` | Creates and applies a dev migration |
| `npm run db:deploy` | Applies pending migrations (production) |
| `npm run db:seed` | Idempotent baseline seed |
| `npm run db:studio` | Prisma Studio |
| `npm test` | Vitest suite for the API |
| `npm run typecheck` | TypeScript across both workspaces |

## Deployment

**Backend — Render.** Connect the repo, pick the `render.yaml` blueprint, set
`DATABASE_URL`, `DIRECT_URL`, `CORS_ORIGINS` and `APP_WEB_URL`. Free instances
sleep after inactivity; the frontend retries with backoff and shows a waking
state rather than an error.

Commit `apps/api/prisma/migrations/` before the first deploy — the build runs
`prisma migrate deploy`, which applies committed migrations and does not
generate them. Also commit `package-lock.json`, since the build uses `npm ci`.

**Frontend — Vercel.** Import the repo with the root directory left at the
repository root — `vercel.json` handles the workspace build. Set
`VITE_API_BASE_URL` to `https://<your-render-service>.onrender.com/api/v1`.

**Database — Neon.** Enable pgvector once per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Use the pooled connection string for `DATABASE_URL` and the direct one for
`DIRECT_URL`, which Prisma Migrate requires.

## Branding

Colours, name, tagline and logo come from the `institutes` table and the
`VITE_*` branding variables. `applyBranding()` writes them into CSS custom
properties, so a white-label deployment needs no code changes.

## Build phases

- **Step 1 (done)** — monorepo, config, health endpoints, deployment configs, schema
- **Phase 1** — auth, RBAC, users, classes, batches, subjects, demo seed
- **Phase 2** — timetable, self-study engine, attendance, materials, homework
- **Phase 3** — tests, question bank, attempts, performance
- **Phase 4** — AI provider abstraction, RAG, task generation, evaluation
- **Phase 5** — viva, voice, proctoring
- **Phase 6** — parent, admin and management dashboards, fees, notifications
