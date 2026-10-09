# AGENTS.md — kube-log-viewer (klv)

## Project Overview

Monorepo for a Kubernetes JSON log viewer with CLI, Web UI, and Desktop app.
Stack: TypeScript, Node.js, Rust, npm workspaces, @kubernetes/client-node, Tauri 2.

## Monorepo Structure

```
packages/
  core/      — @klv/core        (ESM, "type": "module")  — K8s client wrapper + log parser
  cli/       — @klv/cli         (ESM, "type": "module")  — Terminal UI with commander
  web/       — @klv/web         (CommonJS, NestJS)        — REST API + WebSocket gateway
    client/  — @klv/web-client  (ESM, Vite+React 19)     — SPA with Tailwind
  desktop/   — @klv/desktop     (ESM, Tauri 2 + Rust)    — Native desktop app
```

## Build Commands

```bash
# Build everything (core must build first — others depend on it)
npm run build

# Build individual packages
npm run build:core          # tsc in packages/core
npm run build:cli           # tsc in packages/cli (depends on core)
npm run build:web           # Vite client build + nest build
npm run build:desktop       # Tauri build (generates native installers)

# Development
npm run dev:web             # NestJS watch mode (packages/web)
npm run dev:client -w @klv/web  # Vite dev server (packages/web/client, port 5173)
npm run dev:desktop         # Tauri dev mode (Vite + native window)
```

## Tests

No test framework is configured yet. There are no test files, no jest/vitest config,
and no `test` scripts in any package.json. If adding tests:
- Prefer vitest for ESM packages (core, cli)
- Use @nestjs/testing + jest for web package
- Run a single test: `npx vitest run path/to/file.test.ts` (or jest equivalent)

## Lint / Format

No ESLint or Prettier config exists. TypeScript strict mode is the primary code quality tool.
All tsconfig.json files use `"strict": true`. Do not add linter config without discussion.

## TypeScript Configuration

| Package | target | module | moduleResolution | Notes |
|---------|--------|--------|-----------------|-------|
| core    | ES2022 | Node16 | Node16          | ESM, `composite: true`, emits declarations |
| cli     | ES2022 | Node16 | Node16          | ESM, emits declarations |
| web     | ES2022 | commonjs | node           | CJS for NestJS, `emitDecoratorMetadata`, `experimentalDecorators` |
| client  | ES2022 | ESNext | bundler         | `jsx: react-jsx`, bundled by Vite |

All packages: `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`,
`forceConsistentCasingInFileNames: true`, `resolveJsonModule: true`.

## Code Style Guidelines

### Imports

- **ESM packages (core, cli):** Use `.js` extension in relative imports: `import { X } from './foo.js'`
- **Web server (NestJS/CJS):** No extension in relative imports: `import { X } from './foo'`
- **React client:** No extension in relative imports (Vite handles resolution)
- Cross-package imports use the workspace name: `import { KubeClient } from '@klv/core'`
- Use `import type { ... }` for type-only imports; combine with value imports using `type` keyword:
  `import { KubeClient, type PodInfo } from '@klv/core'`
- Node built-ins: use bare specifiers (`'fs'`, `'path'`, `'stream'`)
- Order: external packages first, then internal packages, then relative imports

### Naming Conventions

- **Files:** kebab-case (`kube-client.ts`, `log-parser.ts`, `log.gateway.ts`)
- **Classes:** PascalCase (`KubeClient`, `LogService`, `LogGateway`)
- **Interfaces/Types:** PascalCase (`PodInfo`, `LogOptions`, `ParsedLog`, `LogLevel`)
- **Functions:** camelCase (`parseLogLine`, `matchesFilter`, `formatLog`)
- **Constants:** UPPER_SNAKE_CASE for module-level config objects (`LEVEL_PRIORITY`, `LEVEL_MAP`, `MAX_LOGS`)
- **Variables:** camelCase
- **React components:** PascalCase filenames (`Dashboard.tsx`, `LogLine.tsx`), default export with PascalCase name
- **Hooks:** `use` prefix, camelCase (`useApi`, `useStream`)
- **NestJS:** `<feature>.<type>.ts` pattern (`kube.service.ts`, `log.controller.ts`, `log.gateway.ts`)

### Types

- Use explicit interfaces for data shapes (`PodInfo`, `LogOptions`, `ParsedLog`)
- Use `type` for unions and aliases (`LogLevel = 'TRACE' | 'DEBUG' | ...`)
- Use `Record<string, unknown>` for dynamic/extra fields, not `any`
- Use `any` sparingly — only in catch blocks as `err: any` for `.message` access
- NestJS: use decorators with typed parameters (`@Param('name') name: string`)
- React: use inline `interface Props` at the top of component files
- Generic parameters on hooks: `useApi<T>(url)`, `useState<ParsedLog | null>(null)`

### Error Handling

- **Core library:** Throw `KubeError` (message in Spanish, `statusCode` from the apiserver or 400 for invalid names); validate k8s names with `assertK8sName` before building requests
- **CLI:** Catch in action handlers, show with `spinner.fail()` or `chalk.red()`, `process.exit(1)`
- **NestJS services:** Let NestJS handle exceptions (a global filter maps `KubeError.statusCode` to the HTTP status); use try/catch only for fallback behavior
  (e.g., `getNamespaces` falls back to kubeconfig namespace only on 403)
- **React client:** API calls go through `lib/api.ts`; catch in hooks, store error in state and render it
- **Partial failures:** Report them (e.g., `failedPods` in aggregated logs) instead of silently skipping

### Formatting

- 2-space indentation
- Single quotes for strings
- Trailing commas in multi-line structures
- Semicolons required
- Arrow functions with parens: `(x) => x` not `x => x`
- Template literals for string interpolation: `` `${var}` ``
- Ternary expressions: multi-line for complex conditions, inline for simple ones
- No blank line between interface fields
- One blank line between functions/methods, two blank lines before major sections (CLI commands)

### React Patterns

- Functional components only, with `export default function ComponentName()`
- Props via inline `interface Props` (not exported unless needed elsewhere)
- State via `useState`, effects via `useEffect`; no class components
- Custom hooks return objects: `{ data, loading, error }`
- Use `useMemo` / `useCallback` for expensive computations and stable references
- Tailwind CSS for all styling — no CSS modules or styled-components
- Use the `klv-*` component classes defined in `index.css` (`klv-card`, `klv-btn-primary`, `klv-input`, `klv-select`)
- Inline conditional classes with template literals, not classnames/clsx library
- SVG icons inline (no icon library)
- `useRef` for DOM references (`logEndRef`)

### NestJS Patterns

- One module per feature (`KubeModule`, `LogModule`)
- Module exports services for cross-module injection (`KubeModule` exports `KubeService`)
- Controllers are thin — delegate to services
- WebSocket gateway implements `OnGatewayDisconnect` for cleanup
- Global prefix `api` set in `main.ts`; controllers define relative paths
- `ServeStaticModule` serves the Vite build from `client-dist/`

### Tailwind / Design System

- Dark theme with custom `klv-*` color palette defined in `tailwind.config.js`
- Fonts: Syne (display), Outfit (body), JetBrains Mono (mono)
- Custom animations: `fade-in`, `slide-up`, `slide-in-right`, `pulse-dot`
- Noise texture overlay via `.noise-bg` utility class
- Custom scrollbar styling in `index.css`

## CI/CD (GitHub Actions)

Desktop builds run automatically via `.github/workflows/build-desktop.yml` using `tauri-apps/tauri-action@v1`.

**Triggers:** push to `main`, tags `v*`, PRs to `main`, manual (`workflow_dispatch`)

| Job | Runner | Artifacts |
|-----|--------|-----------|
| macOS (ARM)  | `macos-latest`  | `.dmg` (Apple Silicon) |
| macOS (Intel) | `macos-latest` | `.dmg` (x86_64) |
| Windows      | `windows-latest` | `.msi`, `.exe` (NSIS) |
| Linux        | `ubuntu-22.04`  | `.deb`, `.rpm`, `.AppImage` |

- Tags `v*` create a **draft GitHub Release** with binaries attached
- Rust and npm caches are enabled to speed up builds
- `tauri.conf.json` uses `"targets": "all"` — generates native format per platform automatically
- The desktop package at `packages/desktop` uses `projectPath` in the action since it's a monorepo

## Project Conventions

- UI text and error messages are in Spanish (this is intentional)
- The CLI uses emoji icons in output (e.g., `📋`, `📦`, `✖`)
- The project reads the same kubeconfig as OpenLens (~/.kube/config)
- WebSocket events use `stream:` prefix (`stream:start`, `stream:stop`, `stream:log`, `stream:error`, `stream:end`); every server event carries the `streamId` sent in `stream:start`, and `stream:log` carries a batch (`{ streamId, logs }`). Tauri events use the same names and payloads
- The web server binds `127.0.0.1` by default (`HOST`/`PORT` env) and only accepts WebSocket origins from its own host, the Vite dev server, or `KLV_ALLOWED_ORIGINS`
- Context switches from the Web UI / desktop are in-memory only; only the CLI `use-context` writes `current-context` to the kubeconfig
- The web client proxies `/api` and `/socket.io` to localhost:3000 during development
- Barrel exports from `packages/core/src/index.ts` — always import from `@klv/core`, not deep paths
