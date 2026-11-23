# kube-log-viewer

Monorepo con CLI, Web UI y app de escritorio para ver logs JSON de Kubernetes y operar workloads. Las convenciones y contratos completos estan en `AGENTS.md`.

## Stack
- TypeScript + Node.js (>= 22.13), npm workspaces
- @kubernetes/client-node para conexion a clusters
- NestJS + Socket.IO, React 19 + Vite + Tailwind
- Tauri 2 + Rust (kube-rs) para la app de escritorio
- DuckDB + Parquet para el historial local

## Estructura (monorepo)

### packages/core (@klv/core) — ESM
- src/kube-client.ts — Wrapper del SDK de K8s: pods, workloads, logs, streams, acciones (restart/scale/delete)
- src/log-parser.ts — Parser de logs JSON, reconoce campos comunes
- src/query.ts — Lenguaje de consulta estilo Datadog (parser + evaluador, modulo puro)
- src/errors.ts, src/k8s-names.ts — `KubeError` y validacion de nombres
- src/index.ts — Barrel export
- test/ — Tests de paridad (vitest) con fixtures compartidos con Rust

### packages/cli (@klv/cli) — ESM
- src/cli.ts — Entry point con comandos (contexts, use-context, pods, logs, stream, search, restart, scale, delete-pod)
- src/ui/formatter.ts — Output coloreado por level con iconos
- src/ui/prompts.ts — Selector interactivo de pods/containers

### packages/web (@klv/web) — CommonJS (NestJS)
- src/main.ts — NestJS bootstrap, sirve API y archivos estaticos
- src/app.module.ts — Root module con ServeStaticModule
- src/kube/ — KubeModule (service + controller REST)
- src/log/ — LogModule (service + controller + WebSocket gateway)
- src/history/ — Historial local (recolector, store DuckDB/Parquet, consulta)
- client/ — React 19 + Vite + Tailwind (SPA, compartida con la app de escritorio)
  - src/pages/ — Dashboard, Workloads, Logs, Search, Stream, History
  - src/components/ — ContainerTable, LogDetailPanel, RawJsonView, selectores; explorer/ (Log Explorer) e history/ (recolector)
  - src/hooks/ — useApi, useStream, useWorkloads, useContexts, useExplorerParams, ...
  - src/lib/ — api.ts, tauri.ts (adaptador web/Tauri), facets, histogram, patterns, rollout

### packages/desktop (@klv/desktop) — Tauri 2
- src-tauri/src/commands/ — Comandos Tauri (contexts, namespaces, pods, workloads, logs, history, export)
- src-tauri/src/parser/, src-tauri/src/query.rs — Reimplementacion en Rust del parser y del evaluador de consultas
- src-tauri/src/history/ — Historial local (mismo formato que la web)

## Scripts
- `npm run build` — Build all packages
- `npm run build:core` / `build:cli` / `build:web` / `build:desktop`
- `npm run dev:web` — NestJS watch mode
- `npm run dev:desktop` — Tauri dev
- `npm test -w @klv/core` — Tests de paridad (TS); `cargo test` en `packages/desktop/src-tauri` (Rust)

## Decisiones de diseno
- Lee el mismo kubeconfig que OpenLens
- Parser generico que detecta campos de Spring Boot, NestJS, etc.
- NestJS sirve archivos estaticos del build de Vite (client-dist/)
- WebSocket gateway (Socket.IO) para streaming en tiempo real
- Cada pod recibe un color distinto en modo multi-pod (CLI)
- Parser, evaluador de consultas, historial y acciones de cluster existen en TS y en Rust y deben comportarse igual

## Pendiente
- Modo interactivo con navegacion por teclado (CLI)
