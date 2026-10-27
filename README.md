# 2gis-business-mcp

MCP server for the **2GIS business account** (`account.2gis.com`): read and reply to reviews, edit the company card
(working hours, contacts, attributes, holiday hours).

> ⚠️ Uses the **undocumented** internal API of the 2GIS business cabinet (see [docs/2gis-account-api.md](docs/2gis-account-api.md)).
> It may break without notice, and automated use may conflict with the 2GIS license terms. Use on accounts you own.

## Tools

| Tool | Kind |
|---|---|
| `list_orgs`, `list_branches`, `search_cities`, `get_branch`, `get_branch_attributes`, `get_special_days` | read |
| `list_reviews` (filters: without answer, positive/negative; cursor pagination), `get_review`, `get_rating` | read |
| `reply_to_review`, `delete_review_reply` | write |
| `create_branch` (заявка на модерацию, `buildingId` — id или ссылка `…/geo/<id>`), `update_schedule`, `update_branch`, `update_branch_contacts`, `update_branch_attributes`, `set_special_days` | write |

**Every write tool is a dry run by default** — it returns exactly what would be sent. Nothing changes in 2GIS until the
tool is called again with `confirm: true`. Replies are public, so keep a human in the loop.

## Setup

```bash
npm install
npm run build
```

Credentials (env), one of:

| Variable | |
|---|---|
| `TWOGIS_LOGIN` + `TWOGIS_PASSWORD` | cabinet login; used for the first login and as a fallback |
| `TWOGIS_REFRESH_TOKEN` | value of the `dg_refresh_token` cookie. Note: refreshing may log that browser session out |

Optional: `TWOGIS_API_KEY` (otherwise read from `window.APP_CONFIG` on account.2gis.com), `TWOGIS_LOCALE` (default `ru`),
`TWOGIS_SESSION_FILE` (default `~/.config/2gis-business-mcp/session.json`, mode 0600 — tokens are refreshed and stored there).

### Claude Code

```bash
claude mcp add 2gis-business \
  -e TWOGIS_LOGIN=... -e TWOGIS_PASSWORD=... \
  -- node "/absolute/path/to/dist/index.js"
```

## Development

```bash
npm test          # vitest, no network
npm run typecheck
npm run dev       # run from source with tsx
```
