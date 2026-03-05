# kube-log-viewer Web UI — Design Document

## Context

Migrate kube-log-viewer from CLI-only to a monorepo with NestJS backend + React frontend, while keeping the CLI functional.

## Decisions

- **Monorepo** with npm workspaces
- **Enfoque A**: NestJS serves React static files (single process)
- **Frontend**: React + Vite + Tailwind CSS
- **Streaming**: WebSocket (Socket.IO) via NestJS gateway
- **Shared core**: `@klv/core` package reused by CLI and Web

## Structure

```
kube-log-viewer/
├── package.json                 # root workspaces
├── packages/
│   ├── core/                    # @klv/core
│   │   ├── package.json
│   │   └── src/
│   │       ├── kube-client.ts
│   │       ├── log-parser.ts
│   │       └── index.ts
│   ├── cli/                     # @klv/cli
│   │   ├── package.json
│   │   └── src/
│   │       ├── cli.ts
│   │       └── ui/
│   │           ├── formatter.ts
│   │           └── prompts.ts
│   └── web/                     # @klv/web
│       ├── package.json
│       ├── src/                 # NestJS
│       │   ├── main.ts
│       │   ├── app.module.ts
│       │   ├── kube/
│       │   │   ├── kube.module.ts
│       │   │   ├── kube.service.ts
│       │   │   ├── kube.controller.ts
│       │   │   └── kube.gateway.ts
│       │   └── log/
│       │       ├── log.module.ts
│       │       ├── log.service.ts
│       │       └── log.controller.ts
│       └── client/              # React (Vite)
│           ├── package.json
│           ├── index.html
│           └── src/
│               ├── App.tsx
│               ├── components/
│               ├── hooks/
│               └── pages/
```

## API REST

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/contexts` | List contexts + active |
| PUT | `/api/contexts/:name` | Switch active context |
| GET | `/api/namespaces` | List namespaces |
| GET | `/api/pods/:namespace` | List pods (`?label=`) |
| GET | `/api/pods/:namespace/:pod/logs` | Parsed logs (`?tail=&since=&level=&search=&container=`) |
| GET | `/api/deployments/:namespace` | List deployments |

## WebSocket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `stream:start` | Client -> Server | `{ namespace, pods[], container?, filters? }` |
| `stream:log` | Server -> Client | `{ podName, timestamp, level, message, service, extra }` |
| `stream:error` | Server -> Client | `{ podName, error }` |
| `stream:stop` | Client -> Server | (stops all streams) |

## Frontend Pages

- **Dashboard** (`/`) — Context/namespace selector, pods table with status colors
- **Logs** (`/logs/:namespace/:pod`) — Log viewer with filters (level, search, service), colored by level, raw JSON toggle
- **Stream** (`/stream`) — Multi-pod selection, real-time WebSocket logs, auto-scroll, pause/resume
- **Search** (`/search`) — Full-text search across all pods in namespace

## UI

- Tailwind CSS, dark theme by default
- Same color scheme as CLI: cyan=DEBUG, green=INFO, yellow=WARN, red=ERROR
