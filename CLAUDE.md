# Agentic Inbox — CLAUDE.md

AI-powered, self-hosted email client running entirely on Cloudflare infrastructure (Workers, Durable Objects, R2, Email Routing, Workers AI).

---

## Repository Layout

```
agentic-inbox/
├── app/                        # React 19 frontend (SSR via React Router v7)
│   ├── components/             # UI components (AgentPanel, MCPPanel, EmailPanel, ComposeEmail, Sidebar, …)
│   ├── hooks/                  # Zustand store (useUIStore.ts)
│   ├── queries/                # TanStack React Query hooks (emails, mailboxes, folders, search)
│   ├── routes/                 # React Router page components (home, mailbox, email-list, search-results, settings)
│   ├── services/api.ts         # Fetch wrapper with typed error handling
│   ├── types/index.ts          # Shared TypeScript interfaces (Mailbox, Email, Folder)
│   └── root.tsx                # Root layout, error boundary, query client setup
├── workers/                    # Cloudflare Workers backend
│   ├── app.ts                  # Main Worker entry point — Hono router, CF Access JWT auth
│   ├── index.ts                # API route definitions
│   ├── agent/index.ts          # EmailAgent Durable Object (AIChatAgent)
│   ├── mcp/index.ts            # EmailMCP Durable Object (McpAgent)
│   ├── durableObject/          # MailboxDO Durable Object — SQLite, email storage
│   │   ├── index.ts
│   │   └── migrations.ts
│   ├── db/schema.ts            # Drizzle ORM schema (folders, emails, attachments tables)
│   ├── lib/
│   │   ├── ai.ts               # Prompt injection detection & draft verification helpers
│   │   ├── tools.ts            # Shared email tool implementations (agent + MCP)
│   │   ├── email-helpers.ts    # Email parsing, formatting, thread logic
│   │   ├── attachments.ts      # R2 attachment storage
│   │   ├── mailbox.ts          # Mailbox middleware
│   │   └── schemas.ts          # Zod validation schemas
│   ├── routes/reply-forward.ts # Reply/forward logic
│   ├── email-sender.ts         # Cloudflare Email Service wrapper
│   └── types.ts                # Env bindings interface
├── shared/
│   ├── folders.ts              # Canonical folder IDs, display names — single source of truth
│   └── dates.ts                # Date formatting utilities
├── public/                     # Static assets
├── wrangler.jsonc              # Cloudflare deployment configuration
├── vite.config.ts              # Vite + Cloudflare + Tailwind plugins
├── react-router.config.ts      # SSR: true, v8 Vite environment API flag
└── tsconfig*.json              # Three configs: root, node (build tools), cloudflare (workers)
```

---

## Key Technologies

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router v7 (SSR), Tailwind CSS v4, Zustand, TanStack Query v5, TipTap rich text editor |
| Backend | Hono on Cloudflare Workers, Durable Objects, SQLite (via Drizzle ORM), R2 |
| AI / Agents | Cloudflare Agents SDK (`agents` package), AI SDK v6, workers-ai-provider |
| AI Models | Primary: `@cf/moonshotai/kimi-k2.5` · Draft cleanup: `@cf/meta/llama-4-scout-17b-16e-instruct` · Injection detection: `@cf/meta/llama-3.1-8b-instruct-fast` |
| Email | Cloudflare Email Routing (inbound), Cloudflare Email Service (outbound), PostalMime (parsing) |
| Auth | Cloudflare Access (JWT via `cf-access-jwt-assertion` header), jose for JWKS verification |
| Validation | Zod schemas, DOMPurify for HTML sanitization |
| Build | Vite, Wrangler, TypeScript 5.8 |

---

## Development Commands

```bash
# Local development (Workers + React Router SSR together)
npm run dev

# Type checking (also regenerates Cloudflare binding types + React Router types)
npm run typecheck

# Build for production
npm run build

# Deploy to Cloudflare
npm run deploy

# Regenerate Cloudflare bindings types (run after changing wrangler.jsonc)
npm run cf-typegen
```

**No test runner is configured.** Correctness is enforced by TypeScript strict mode and Zod runtime validation.

---

## Architecture Overview

### Request Routing (workers/app.ts)

All traffic enters a single Hono app:
1. **CF Access JWT middleware** — validates `cf-access-jwt-assertion` header in production; skipped in dev (`import.meta.env.DEV`).
2. **`/mcp` and `/mcp/*`** — routes to `EmailMCP` Durable Object (Model Context Protocol server).
3. **`/api/*`** — routes to API handlers in `workers/index.ts`.
4. **`/agents/*`** — routes to `routeAgentRequest` (WebSocket upgrades for `EmailAgent`).
5. **`*`** — falls through to React Router SSR handler.

The `email` export on the default object handles inbound email from Cloudflare Email Routing.

### Durable Objects

Three Durable Objects, each with isolated SQLite storage:

| Class | Binding | Purpose |
|---|---|---|
| `MailboxDO` | `MAILBOX` | Persistent email storage — folders, emails, attachments metadata, search |
| `EmailAgent` | `EMAIL_AGENT` | AI chat agent per mailbox — persistent conversation history, email tools |
| `EmailMCP` | `EMAIL_MCP` | MCP server — exposes email tools to external AI assistants |

Each mailbox (`mailbox@example.com`) gets its own Durable Object instance for all three classes.

### Database Schema (workers/db/schema.ts)

Drizzle ORM with SQLite inside Durable Objects:

- **`folders`**: `id` (PK), `name`, `is_deletable`
- **`emails`**: `id`, `folder_id` (FK→folders, cascade delete), `subject`, `sender`, `recipient`, `cc`, `bcc`, `date`, `read`, `starred`, `body`, `in_reply_to`, `email_references`, `thread_id`, `message_id`, `raw_headers`
- **`attachments`**: `id`, `email_id` (FK→emails, cascade delete), `filename`, `mimetype`, `size`, `content_id`, `disposition`

Attachment bodies are stored in R2 (not in SQLite).

### Folder System (shared/folders.ts)

**Always import folder IDs from `shared/folders.ts`** — never use magic strings:

```ts
import { Folders, SYSTEM_FOLDER_IDS, FOLDER_DISPLAY_NAMES, getFolderDisplayName } from "~/shared/folders";

// Folder IDs: "inbox" | "sent" | "draft" | "archive" | "trash" | "spam"
Folders.INBOX   // "inbox"
Folders.DRAFT   // "draft"
```

### AI Agent (workers/agent/index.ts)

`EmailAgent` extends `AIChatAgent` from the Cloudflare Agents SDK:
- WebSocket-based streaming chat at `/agents/email-agent/:mailboxId`
- 9 tools: `list_emails`, `get_email`, `get_thread`, `search_emails`, `draft_reply`, `draft_email`, `mark_email_read`, `move_email`, `discard_draft`
- Auto-invoked on inbound email — checks for prompt injection before drafting
- System prompt is customizable per mailbox (stored in R2)
- Draft verification runs after generation to strip agent artifacts

### Security: Prompt Injection (workers/lib/ai.ts)

`isPromptInjection(text)` scans email body/thread using Llama 3.1 8B before any AI draft generation. If injection is detected, auto-draft is skipped entirely. `verifyDraft(draft)` uses Llama Scout to clean artifacts from generated drafts, falling back to the original if >50% would be stripped.

### MCP Server (workers/mcp/index.ts)

`EmailMCP` extends `McpAgent` and exposes email operations at `/mcp` using the Model Context Protocol. External tools (Claude Code, Cursor, etc.) can connect here to read/write emails. Exposes all agent tools plus `create_draft`, `update_draft`, `send_reply`, `send_email`, `delete_email`.

---

## Environment Variables & Bindings

### Secrets (set via Wrangler / `.dev.vars`)

| Variable | Required | Description |
|---|---|---|
| `POLICY_AUD` | Production | Cloudflare Access policy audience tag |
| `TEAM_DOMAIN` | Production | Cloudflare Access team URL or full `/cdn-cgi/access/certs` URL |

Copy `.dev.vars.example` to `.dev.vars` for local development (auth is skipped in dev mode).

### Wrangler Bindings (wrangler.jsonc)

| Binding | Type | Description |
|---|---|---|
| `BUCKET` | R2 | Attachment storage bucket (`agentic-inbox`) |
| `EMAIL` | Email Service | Outbound email sending |
| `AI` | Workers AI | LLM inference |
| `MAILBOX` | Durable Object | Email storage per mailbox |
| `EMAIL_AGENT` | Durable Object | AI chat agent per mailbox |
| `EMAIL_MCP` | Durable Object | MCP server instance |

### Config Vars (wrangler.jsonc `vars`)

| Variable | Description |
|---|---|
| `DOMAINS` | Domain(s) for email routing (e.g., `example.com`) |
| `EMAIL_ADDRESSES` | Optional allowlist for mailbox creation |

---

## API Routes

All routes are under `/api/v1/` and require a valid Cloudflare Access JWT in production.

```
GET/POST   /api/v1/mailboxes                              List / create mailboxes
GET/PUT/DELETE /api/v1/mailboxes/:mailboxId               Get / update / delete mailbox
GET/POST   /api/v1/mailboxes/:mailboxId/emails            List / create emails
GET/PUT/DELETE /api/v1/mailboxes/:mailboxId/emails/:id    Get / update / delete email
POST       /api/v1/mailboxes/:mailboxId/emails/:id/reply  Reply to email
POST       /api/v1/mailboxes/:mailboxId/emails/:id/forward Forward email
GET        /api/v1/mailboxes/:mailboxId/search            Full-text search
GET/POST/PUT/DELETE /api/v1/mailboxes/:mailboxId/folders  Folder management
```

---

## Frontend Conventions

- **State management**: Zustand for UI state (`app/hooks/useUIStore.ts`), TanStack Query for server state (`app/queries/`).
- **API calls**: Always use `app/services/api.ts` — it handles typed errors, retry logic (2 retries, no retry for 4xx).
- **Query keys**: Centralized in `app/queries/keys.ts`.
- **Icons**: `@phosphor-icons/react` only.
- **Design system**: `@cloudflare/kumo` components for UI primitives.
- **Rich text**: TipTap editor in `ComposeEmail` — do not swap editors without updating toolbar components.

---

## TypeScript Configuration

Three tsconfig files are used together:

| Config | Applies to |
|---|---|
| `tsconfig.json` | Root — references the other two |
| `tsconfig.node.json` | Vite config, build tools |
| `tsconfig.cloudflare.json` | Workers code (`workers/`) |

All configs use strict mode. Run `npm run typecheck` (which runs `cf-typegen` + `react-router typegen` + `tsc -b`) before committing.

---

## Deployment

1. Configure Cloudflare Access policy and note the audience tag.
2. Set `POLICY_AUD` and `TEAM_DOMAIN` as Wrangler secrets.
3. Create an R2 bucket named `agentic-inbox`.
4. Configure Cloudflare Email Routing to forward to this Worker.
5. Run `npm run deploy`.

Durable Object migrations are declared in `wrangler.jsonc` under `"migrations"` and apply automatically on deploy.

---

## Conventions & Gotchas

- **Folder IDs are always lowercase strings** — `"inbox"`, `"draft"`, etc. Import from `shared/folders.ts`, never hardcode.
- **Attachment bodies go to R2, not SQLite** — only metadata is in the `attachments` table.
- **Auth is skipped in dev** — `import.meta.env.DEV` gates the JWT middleware; do not rely on auth in local testing.
- **Error rethrow in email handler** — `workers/app.ts` rethrows errors from `receiveEmail` so Cloudflare can retry/bounce instead of silently dropping mail.
- **MCP must be mounted before React Router catch-all** — order in `workers/app.ts` is intentional.
- **Agent WebSocket routing** (`/agents/*`) must also precede the React Router catch-all.
- **Drizzle migrations** live in `workers/durableObject/migrations.ts` — run during `MailboxDO` initialization, not via a standalone CLI.
- **No `gh` CLI** — use `mcp__github__*` tools for all GitHub interactions.
