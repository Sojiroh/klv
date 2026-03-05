# kube-log-viewer

Monorepo con CLI y Web UI para ver logs JSON de Kubernetes.

## Stack
- TypeScript + Node.js
- npm workspaces (monorepo)
- @kubernetes/client-node para conexion a clusters

## Estructura (monorepo)

### packages/core (@klv/core) — ESM
- src/kube-client.ts — Wrapper del SDK de K8s, lee kubeconfig
- src/log-parser.ts — Parser de logs JSON, reconoce campos comunes
- src/index.ts — Barrel export

### packages/cli (@klv/cli) — ESM
- src/cli.ts — Entry point con comandos (contexts, pods, logs, stream, search)
- src/ui/formatter.ts — Output coloreado por level con iconos
- src/ui/prompts.ts — Selector interactivo de pods/containers

### packages/web (@klv/web) — CommonJS (NestJS)
- src/main.ts — NestJS bootstrap, sirve API y archivos estaticos
- src/app.module.ts — Root module con ServeStaticModule
- src/kube/ — KubeModule (service + controller REST)
- src/log/ — LogModule (service + controller + WebSocket gateway)
- client/ — React 19 + Vite + Tailwind (SPA)
  - src/pages/ — Dashboard, Logs, Stream, Search
  - src/components/ — ContextSelector, PodTable, LogLine, LogFilters
  - src/hooks/ — useApi, useStream

## Scripts
- `npm run build` — Build all packages
- `npm run build:core` / `build:cli` / `build:web`
- `npm run dev:web` — NestJS watch mode

## Decisiones de diseno
- Lee el mismo kubeconfig que OpenLens
- Parser generico que detecta campos de Spring Boot, NestJS, etc.
- NestJS sirve archivos estaticos del build de Vite (client-dist/)
- WebSocket gateway (Socket.IO) para streaming en tiempo real
- Cada pod recibe un color distinto en modo multi-pod (CLI)

## Pendiente
- Modo interactivo con navegacion por teclado (CLI)
