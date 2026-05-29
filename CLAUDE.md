# atlas-fit

Training, health, and sleep tracking service. Part of the Atlas ecosystem.

## Stack

Node.js + Express + EJS + Docker. Port 3457.

## Layout

| Path | Purpose |
|------|---------|
| `server.js` | All routes and business logic |
| `views/` | EJS templates |
| `views/partials/` | head, nav, footer shared partials |
| `public/` | Static assets (CSS, JS, images) |

## Running locally

```bash
# Via Docker (recommended — same as production)
# Add to atlas-core docker-compose.yml — see plans/todos/atlas-fit.md

# Direct
npm install
node server.js
```

## API contract

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Container health check |
| `GET /api/widget/summary` | Dashboard card for atlas-core |
| `GET /api/today` | Today's planned workout (plan-day briefing) |
| `GET /api/training-events` | 12-week training calendar events (atlas-core /calendar) |

## Data

Reads from `data/health/` (bind-mounted at `/atlas-data/health` in Docker):
- `training-plan.json`
- `fitness-log.json`
- `sleep-log.json`
- `health-goals.json`

## Code style

- 2-space indentation
- `const` over `let`, no `var`
- Template literals, no string concatenation
- No comments restating what the code does
