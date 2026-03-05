# NestJS + React Web UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate kube-log-viewer to a monorepo with shared core, NestJS API + WebSocket backend, and React frontend with Tailwind.

**Architecture:** Monorepo with npm workspaces. Three packages: `@klv/core` (shared kube-client + log-parser), `@klv/cli` (existing CLI), `@klv/web` (NestJS serving React static files). WebSocket gateway for real-time log streaming.

**Tech Stack:** TypeScript, NestJS, React 18, Vite, Tailwind CSS, Socket.IO, React Router, @kubernetes/client-node

---

### Task 1: Set up monorepo structure and move core package

**Files:**
- Modify: `package.json` (root — convert to workspaces)
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Move: `src/core/kube-client.ts` -> `packages/core/src/kube-client.ts`
- Move: `src/core/log-parser.ts` -> `packages/core/src/log-parser.ts`

**Step 1: Create packages/core directory and package.json**

```bash
mkdir -p packages/core/src
```

`packages/core/package.json`:
```json
{
  "name": "@klv/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@kubernetes/client-node": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "composite": true
  },
  "include": ["src/**/*"]
}
```

**Step 2: Move core files**

Copy `src/core/kube-client.ts` to `packages/core/src/kube-client.ts` (no changes needed — it has no CLI-specific imports).

Copy `src/core/log-parser.ts` to `packages/core/src/log-parser.ts` (no changes needed).

**Step 3: Create the barrel export**

`packages/core/src/index.ts`:
```typescript
export { KubeClient } from './kube-client.js';
export type { PodInfo, LogOptions } from './kube-client.js';
export { parseLogLine, matchesFilter } from './log-parser.js';
export type { ParsedLog, LogLevel, LogFilter } from './log-parser.js';
export { LEVEL_PRIORITY } from './log-parser.js';
```

Note: `LEVEL_PRIORITY` must be exported from `log-parser.ts` — add `export` before `const LEVEL_PRIORITY` in the moved file (line 179 of original).

**Step 4: Update root package.json for workspaces**

Replace root `package.json` with:
```json
{
  "name": "kube-log-viewer",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "build:core": "npm run build -w @klv/core",
    "build:cli": "npm run build -w @klv/cli",
    "build:web": "npm run build -w @klv/web",
    "dev:web": "npm run dev -w @klv/web"
  }
}
```

**Step 5: Verify core builds**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/core/ package.json
git commit -m "feat: extract @klv/core package for monorepo"
```

---

### Task 2: Move CLI to its own package

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Move: `src/cli.ts` -> `packages/cli/src/cli.ts`
- Move: `src/ui/formatter.ts` -> `packages/cli/src/ui/formatter.ts`
- Move: `src/ui/prompts.ts` -> `packages/cli/src/ui/prompts.ts`
- Delete: old `src/` directory, old `tsconfig.json`

**Step 1: Create packages/cli structure**

```bash
mkdir -p packages/cli/src/ui
```

`packages/cli/package.json`:
```json
{
  "name": "@klv/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "klv": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "start": "node dist/cli.js"
  },
  "dependencies": {
    "@klv/core": "*",
    "chalk": "^5.3.0",
    "cli-table3": "^0.6.5",
    "commander": "^12.1.0",
    "date-fns": "^3.6.0",
    "ora": "^8.0.1",
    "strip-ansi": "^7.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 2: Move CLI files**

- Copy `src/cli.ts` -> `packages/cli/src/cli.ts`
- Copy `src/ui/formatter.ts` -> `packages/cli/src/ui/formatter.ts`
- Copy `src/ui/prompts.ts` -> `packages/cli/src/ui/prompts.ts`

**Step 3: Update imports in cli.ts**

Replace:
```typescript
import { KubeClient } from './core/kube-client.js';
import { parseLogLine, matchesFilter, type LogFilter, type LogLevel, type ParsedLog } from './core/log-parser.js';
```
With:
```typescript
import { KubeClient, parseLogLine, matchesFilter, type LogFilter, type LogLevel, type ParsedLog } from '@klv/core';
```

**Step 4: Update imports in formatter.ts**

Replace:
```typescript
import type { ParsedLog, LogLevel } from '../core/log-parser.js';
```
With:
```typescript
import type { ParsedLog, LogLevel } from '@klv/core';
```

**Step 5: Delete old src/ and tsconfig.json from root**

```bash
rm -rf src/ tsconfig.json
```

**Step 6: Install workspaces and verify CLI builds**

```bash
npm install
npm run build:core
npm run build:cli
```
Expected: Both build without errors

**Step 7: Verify CLI still works**

```bash
node packages/cli/dist/cli.js --help
```
Expected: Shows help with all commands (contexts, use-context, pods, logs, stream, search)

**Step 8: Commit**

```bash
git add packages/cli/ -A
git commit -m "feat: move CLI to @klv/cli package"
```

---

### Task 3: Set up NestJS backend (@klv/web)

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/nest-cli.json`
- Create: `packages/web/src/main.ts`
- Create: `packages/web/src/app.module.ts`

**Step 1: Create web package structure**

```bash
mkdir -p packages/web/src
```

`packages/web/package.json`:
```json
{
  "name": "@klv/web",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@klv/core": "*",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/platform-socket.io": "^11.0.0",
    "@nestjs/serve-static": "^5.0.0",
    "@nestjs/websockets": "^11.0.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"]
}
```

Note: NestJS requires `commonjs` module and `emitDecoratorMetadata` + `experimentalDecorators` for decorators.

`packages/web/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

**Step 2: Create main.ts**

`packages/web/src/main.ts`:
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(3000);
  console.log(`KLV Web running on http://localhost:3000`);
}
bootstrap();
```

**Step 3: Create app.module.ts**

`packages/web/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({
  imports: [],
})
export class AppModule {}
```

**Step 4: Install deps and verify NestJS starts**

```bash
npm install
cd packages/web && npx nest build
```
Expected: Builds without errors

**Step 5: Commit**

```bash
git add packages/web/
git commit -m "feat: scaffold @klv/web NestJS package"
```

---

### Task 4: Implement KubeModule (service + REST controller)

**Files:**
- Create: `packages/web/src/kube/kube.module.ts`
- Create: `packages/web/src/kube/kube.service.ts`
- Create: `packages/web/src/kube/kube.controller.ts`
- Modify: `packages/web/src/app.module.ts`

**Step 1: Create kube.service.ts**

`packages/web/src/kube/kube.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { KubeClient, type PodInfo, type LogOptions } from '@klv/core';

@Injectable()
export class KubeService {
  private client: KubeClient;

  constructor() {
    this.client = new KubeClient();
  }

  getContexts() {
    return {
      contexts: this.client.getContexts(),
      current: this.client.getCurrentContext(),
    };
  }

  useContext(name: string) {
    this.client.useContext(name);
    // Recreate client with new context
    this.client = new KubeClient();
    return { current: this.client.getCurrentContext() };
  }

  getNamespaces() {
    return this.client.getNamespaces();
  }

  getPods(namespace: string, label?: string) {
    return this.client.getPods(namespace, label);
  }

  getDeployments(namespace: string) {
    return this.client.getDeployments(namespace);
  }

  getLogs(options: LogOptions) {
    return this.client.getLogs(options);
  }

  getClient() {
    return this.client;
  }
}
```

**Step 2: Create kube.controller.ts**

`packages/web/src/kube/kube.controller.ts`:
```typescript
import { Controller, Get, Put, Param, Query } from '@nestjs/common';
import { KubeService } from './kube.service';

@Controller()
export class KubeController {
  constructor(private readonly kubeService: KubeService) {}

  @Get('contexts')
  getContexts() {
    return this.kubeService.getContexts();
  }

  @Put('contexts/:name')
  useContext(@Param('name') name: string) {
    return this.kubeService.useContext(name);
  }

  @Get('namespaces')
  getNamespaces() {
    return this.kubeService.getNamespaces();
  }

  @Get('pods/:namespace')
  getPods(
    @Param('namespace') namespace: string,
    @Query('label') label?: string,
  ) {
    return this.kubeService.getPods(namespace, label);
  }

  @Get('deployments/:namespace')
  getDeployments(@Param('namespace') namespace: string) {
    return this.kubeService.getDeployments(namespace);
  }
}
```

**Step 3: Create kube.module.ts**

`packages/web/src/kube/kube.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { KubeController } from './kube.controller';
import { KubeService } from './kube.service';

@Module({
  controllers: [KubeController],
  providers: [KubeService],
  exports: [KubeService],
})
export class KubeModule {}
```

**Step 4: Register in app.module.ts**

Update `packages/web/src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { KubeModule } from './kube/kube.module';

@Module({
  imports: [KubeModule],
})
export class AppModule {}
```

**Step 5: Build and verify**

```bash
cd packages/web && npx nest build
```
Expected: No errors

**Step 6: Commit**

```bash
git add packages/web/src/kube/ packages/web/src/app.module.ts
git commit -m "feat: add KubeModule with REST endpoints"
```

---

### Task 5: Implement LogModule (service + controller + WebSocket gateway)

**Files:**
- Create: `packages/web/src/log/log.module.ts`
- Create: `packages/web/src/log/log.service.ts`
- Create: `packages/web/src/log/log.controller.ts`
- Create: `packages/web/src/log/log.gateway.ts`
- Modify: `packages/web/src/app.module.ts`

**Step 1: Create log.service.ts**

`packages/web/src/log/log.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { parseLogLine, matchesFilter, type ParsedLog, type LogFilter, type LogLevel } from '@klv/core';
import { KubeService } from '../kube/kube.service';

@Injectable()
export class LogService {
  constructor(private readonly kubeService: KubeService) {}

  async getParsedLogs(options: {
    namespace: string;
    pod: string;
    container?: string;
    tail?: number;
    since?: number;
    level?: string;
    search?: string;
  }): Promise<{ logs: ParsedLog[]; total: number }> {
    const raw = await this.kubeService.getLogs({
      namespace: options.namespace,
      podName: options.pod,
      container: options.container,
      tailLines: options.tail ?? 100,
      sinceSeconds: options.since,
    });

    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = lines.map((line) => parseLogLine(line, options.pod));

    const filter: LogFilter = {};
    if (options.level) filter.minLevel = options.level.toUpperCase() as LogLevel;
    if (options.search) filter.search = options.search;

    const filtered = parsed.filter((log) => matchesFilter(log, filter));

    return { logs: filtered, total: parsed.length };
  }
}
```

**Step 2: Create log.controller.ts**

`packages/web/src/log/log.controller.ts`:
```typescript
import { Controller, Get, Param, Query } from '@nestjs/common';
import { LogService } from './log.service';

@Controller()
export class LogController {
  constructor(private readonly logService: LogService) {}

  @Get('pods/:namespace/:pod/logs')
  getLogs(
    @Param('namespace') namespace: string,
    @Param('pod') pod: string,
    @Query('container') container?: string,
    @Query('tail') tail?: string,
    @Query('since') since?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ) {
    return this.logService.getParsedLogs({
      namespace,
      pod,
      container,
      tail: tail ? parseInt(tail, 10) : undefined,
      since: since ? parseInt(since, 10) : undefined,
      level,
      search,
    });
  }
}
```

**Step 3: Create log.gateway.ts (WebSocket)**

`packages/web/src/log/log.gateway.ts`:
```typescript
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { parseLogLine, matchesFilter, type LogFilter, type LogLevel } from '@klv/core';
import { KubeService } from '../kube/kube.service';

interface StreamStartPayload {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
    excludePatterns?: string[];
  };
}

@WebSocketGateway({ cors: true })
export class LogGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private cleanupMap = new Map<string, (() => void)[]>();

  constructor(private readonly kubeService: KubeService) {}

  handleDisconnect(client: Socket) {
    this.stopStreams(client.id);
  }

  @SubscribeMessage('stream:start')
  async handleStreamStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: StreamStartPayload,
  ) {
    // Stop existing streams for this client
    this.stopStreams(client.id);

    const cleanups: (() => void)[] = [];
    const kubeClient = this.kubeService.getClient();

    const filter: LogFilter = {};
    if (payload.filters?.level) filter.minLevel = payload.filters.level.toUpperCase() as LogLevel;
    if (payload.filters?.search) filter.search = payload.filters.search;
    if (payload.filters?.excludePatterns) filter.excludePatterns = payload.filters.excludePatterns;

    for (const podName of payload.pods) {
      try {
        const cleanup = await kubeClient.streamLogs(
          {
            namespace: payload.namespace,
            podName,
            container: payload.container,
            follow: true,
            tailLines: 50,
          },
          (line, pod) => {
            const parsed = parseLogLine(line, pod);
            if (matchesFilter(parsed, filter)) {
              client.emit('stream:log', parsed);
            }
          },
          (err, pod) => {
            client.emit('stream:error', { podName: pod, error: err.message });
          },
        );
        cleanups.push(cleanup);
      } catch (err: any) {
        client.emit('stream:error', { podName, error: err.message });
      }
    }

    this.cleanupMap.set(client.id, cleanups);
  }

  @SubscribeMessage('stream:stop')
  handleStreamStop(@ConnectedSocket() client: Socket) {
    this.stopStreams(client.id);
  }

  private stopStreams(clientId: string) {
    const cleanups = this.cleanupMap.get(clientId);
    if (cleanups) {
      cleanups.forEach((fn) => fn());
      this.cleanupMap.delete(clientId);
    }
  }
}
```

**Step 4: Create log.module.ts**

`packages/web/src/log/log.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { LogGateway } from './log.gateway';
import { KubeModule } from '../kube/kube.module';

@Module({
  imports: [KubeModule],
  controllers: [LogController],
  providers: [LogService, LogGateway],
})
export class LogModule {}
```

**Step 5: Update app.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { KubeModule } from './kube/kube.module';
import { LogModule } from './log/log.module';

@Module({
  imports: [KubeModule, LogModule],
})
export class AppModule {}
```

**Step 6: Build and verify**

```bash
cd packages/web && npx nest build
```
Expected: No errors

**Step 7: Commit**

```bash
git add packages/web/src/log/ packages/web/src/app.module.ts
git commit -m "feat: add LogModule with REST + WebSocket gateway"
```

---

### Task 6: Scaffold React frontend with Vite + Tailwind

**Files:**
- Create: `packages/web/client/package.json`
- Create: `packages/web/client/index.html`
- Create: `packages/web/client/vite.config.ts`
- Create: `packages/web/client/tsconfig.json`
- Create: `packages/web/client/src/main.tsx`
- Create: `packages/web/client/src/App.tsx`
- Create: `packages/web/client/src/index.css`

**Step 1: Create client directory and initialize**

```bash
mkdir -p packages/web/client/src
```

`packages/web/client/package.json`:
```json
{
  "name": "@klv/web-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "socket.io-client": "^4.7.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
}
```

**Step 2: Create vite.config.ts**

`packages/web/client/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../client-dist',
    emptyOutDir: true,
  },
});
```

**Step 3: Create tsconfig.json, Tailwind config, PostCSS config**

`packages/web/client/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`packages/web/client/tailwind.config.js`:
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

`packages/web/client/postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**Step 4: Create entry files**

`packages/web/client/index.html`:
```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KLV — Kubernetes Log Viewer</title>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

`packages/web/client/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`packages/web/client/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`packages/web/client/src/App.tsx`:
```tsx
import { Routes, Route, Link, useLocation } from 'react-router-dom';

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-gray-500 text-lg">{name} — Coming soon</p>
    </div>
  );
}

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/stream', label: 'Stream' },
  { path: '/search', label: 'Search' },
];

export default function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen">
      <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
        <span className="text-lg font-bold text-cyan-400">KLV</span>
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`text-sm ${
              location.pathname === item.path
                ? 'text-white font-medium'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Placeholder name="Dashboard" />} />
          <Route path="/logs/:namespace/:pod" element={<Placeholder name="Logs" />} />
          <Route path="/stream" element={<Placeholder name="Stream" />} />
          <Route path="/search" element={<Placeholder name="Search" />} />
        </Routes>
      </main>
    </div>
  );
}
```

**Step 5: Install and verify Vite starts**

```bash
cd packages/web/client && npm install && npx vite build
```
Expected: Build completes, output in `packages/web/client-dist/`

**Step 6: Commit**

```bash
git add packages/web/client/
git commit -m "feat: scaffold React frontend with Vite + Tailwind"
```

---

### Task 7: Configure NestJS to serve React static files

**Files:**
- Modify: `packages/web/src/main.ts`
- Modify: `packages/web/src/app.module.ts`
- Modify: `packages/web/package.json` (add build:client script)

**Step 1: Update app.module.ts to serve static files**

```typescript
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { KubeModule } from './kube/kube.module';
import { LogModule } from './log/log.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'client-dist'),
      exclude: ['/api/(.*)'],
    }),
    KubeModule,
    LogModule,
  ],
})
export class AppModule {}
```

**Step 2: Update web package.json scripts**

Add to `packages/web/package.json` scripts:
```json
{
  "scripts": {
    "build:client": "cd client && npm run build",
    "build": "npm run build:client && nest build",
    "dev": "nest start --watch",
    "dev:client": "cd client && npm run dev",
    "start": "node dist/main.js"
  }
}
```

**Step 3: Build everything and verify**

```bash
npm run build:core
npm run build:web
cd packages/web && node dist/main.js
```
Expected: Server starts on port 3000, opening http://localhost:3000 shows the React app with nav bar, http://localhost:3000/api/contexts returns JSON

**Step 4: Commit**

```bash
git add packages/web/
git commit -m "feat: NestJS serves React static files"
```

---

### Task 8: Build Dashboard page (context/namespace selector + pods table)

**Files:**
- Create: `packages/web/client/src/hooks/useApi.ts`
- Create: `packages/web/client/src/pages/Dashboard.tsx`
- Create: `packages/web/client/src/components/PodTable.tsx`
- Create: `packages/web/client/src/components/ContextSelector.tsx`
- Modify: `packages/web/client/src/App.tsx` (replace placeholder)

**Step 1: Create useApi hook**

`packages/web/client/src/hooks/useApi.ts`:
```tsx
import { useState, useEffect } from 'react';

export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    setError(null);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [url]);

  return { data, loading, error, refetch: () => setData(null) };
}
```

**Step 2: Create ContextSelector component**

`packages/web/client/src/components/ContextSelector.tsx`:
```tsx
interface Props {
  contexts: string[];
  current: string;
  onSwitch: (name: string) => void;
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (ns: string) => void;
}

export default function ContextSelector({
  contexts, current, onSwitch,
  namespaces, namespace, onNamespaceChange,
}: Props) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <label className="text-sm text-gray-400">Context:</label>
      <select
        value={current}
        onChange={(e) => onSwitch(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        {contexts.map((ctx) => (
          <option key={ctx} value={ctx}>{ctx}</option>
        ))}
      </select>

      <label className="text-sm text-gray-400 ml-4">Namespace:</label>
      <select
        value={namespace}
        onChange={(e) => onNamespaceChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        {namespaces.map((ns) => (
          <option key={ns} value={ns}>{ns}</option>
        ))}
      </select>
    </div>
  );
}
```

**Step 3: Create PodTable component**

`packages/web/client/src/components/PodTable.tsx`:
```tsx
import { Link } from 'react-router-dom';

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

const statusColor: Record<string, string> = {
  Running: 'text-green-400',
  Pending: 'text-yellow-400',
  Succeeded: 'text-blue-400',
  Failed: 'text-red-400',
  Unknown: 'text-gray-400',
};

export default function PodTable({ pods, namespace }: { pods: Pod[]; namespace: string }) {
  if (pods.length === 0) {
    return <p className="text-gray-500 py-8 text-center">No pods found</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400 text-left">
          <th className="py-2 px-3">#</th>
          <th className="py-2 px-3">Pod</th>
          <th className="py-2 px-3">Status</th>
          <th className="py-2 px-3">Containers</th>
          <th className="py-2 px-3">Age</th>
          <th className="py-2 px-3"></th>
        </tr>
      </thead>
      <tbody>
        {pods.map((pod, i) => (
          <tr key={pod.name} className="border-b border-gray-900 hover:bg-gray-900/50">
            <td className="py-2 px-3 text-gray-500">{i + 1}</td>
            <td className="py-2 px-3 font-mono">{pod.name}</td>
            <td className={`py-2 px-3 ${statusColor[pod.status] ?? 'text-gray-400'}`}>
              {pod.status}
            </td>
            <td className="py-2 px-3 text-gray-400">{pod.containers.join(', ')}</td>
            <td className="py-2 px-3 text-gray-400">{pod.age}</td>
            <td className="py-2 px-3">
              <Link
                to={`/logs/${namespace}/${pod.name}`}
                className="text-cyan-400 hover:text-cyan-300 text-xs"
              >
                View Logs
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

**Step 4: Create Dashboard page**

`packages/web/client/src/pages/Dashboard.tsx`:
```tsx
import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import ContextSelector from '../components/ContextSelector';
import PodTable from '../components/PodTable';

interface ContextsResponse {
  contexts: string[];
  current: string;
}

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

export default function Dashboard() {
  const [namespace, setNamespace] = useState('default');
  const { data: ctxData } = useApi<ContextsResponse>('/api/contexts');
  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods, loading } = useApi<Pod[]>(`/api/pods/${namespace}`);

  const handleContextSwitch = async (name: string) => {
    await fetch(`/api/contexts/${name}`, { method: 'PUT' });
    window.location.reload();
  };

  return (
    <div>
      {ctxData && namespaces && (
        <ContextSelector
          contexts={ctxData.contexts}
          current={ctxData.current}
          onSwitch={handleContextSwitch}
          namespaces={namespaces}
          namespace={namespace}
          onNamespaceChange={setNamespace}
        />
      )}

      <h2 className="text-lg font-semibold mb-4">
        Pods in <span className="text-cyan-400">{namespace}</span>
      </h2>

      {loading && <p className="text-gray-500">Loading pods...</p>}
      {pods && <PodTable pods={pods} namespace={namespace} />}
    </div>
  );
}
```

**Step 5: Update App.tsx to use Dashboard**

Replace the `Placeholder` for `/` route with:
```tsx
import Dashboard from './pages/Dashboard';
// ...
<Route path="/" element={<Dashboard />} />
```

**Step 6: Build and verify**

```bash
cd packages/web/client && npx vite build
```
Expected: Builds without errors

**Step 7: Commit**

```bash
git add packages/web/client/src/
git commit -m "feat: Dashboard page with context/namespace selector and pods table"
```

---

### Task 9: Build Logs page (filtered log viewer)

**Files:**
- Create: `packages/web/client/src/pages/Logs.tsx`
- Create: `packages/web/client/src/components/LogLine.tsx`
- Create: `packages/web/client/src/components/LogFilters.tsx`
- Modify: `packages/web/client/src/App.tsx`

**Step 1: Create LogLine component**

`packages/web/client/src/components/LogLine.tsx`:
```tsx
interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  error?: string;
  stackTrace?: string;
  extra: Record<string, unknown>;
}

const levelColors: Record<string, string> = {
  TRACE: 'text-gray-500',
  DEBUG: 'text-cyan-400',
  INFO: 'text-green-400',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-400',
  FATAL: 'text-red-600 font-bold',
  UNKNOWN: 'text-gray-400',
};

const levelIcons: Record<string, string> = {
  TRACE: '\u00B7', DEBUG: '\u25CB', INFO: '\u25CF',
  WARN: '\u25B2', ERROR: '\u2716', FATAL: '\u2620', UNKNOWN: '?',
};

function formatTime(ts?: string): string {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return ts.substring(0, 12);
  }
}

export default function LogLine({ log, showRaw }: { log: ParsedLog; showRaw: boolean }) {
  if (showRaw) {
    return (
      <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap py-0.5">
        {log.isJson ? JSON.stringify(JSON.parse(log.raw), null, 2) : log.raw}
      </pre>
    );
  }

  return (
    <div className="font-mono text-xs py-0.5 flex gap-2 hover:bg-gray-900/30">
      <span className="text-gray-500 shrink-0">{formatTime(log.timestamp)}</span>
      <span className={`shrink-0 w-14 ${levelColors[log.level] ?? 'text-gray-400'}`}>
        {levelIcons[log.level] ?? '?'} {log.level.padEnd(5)}
      </span>
      {log.service && <span className="text-blue-400 shrink-0">({log.service})</span>}
      <span className={log.level === 'ERROR' || log.level === 'FATAL' ? 'text-red-300' : 'text-gray-200'}>
        {log.message}
      </span>
    </div>
  );
}
```

**Step 2: Create LogFilters component**

`packages/web/client/src/components/LogFilters.tsx`:
```tsx
interface Props {
  level: string;
  search: string;
  showRaw: boolean;
  onLevelChange: (level: string) => void;
  onSearchChange: (search: string) => void;
  onRawToggle: () => void;
}

const levels = ['', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

export default function LogFilters({ level, search, showRaw, onLevelChange, onSearchChange, onRawToggle }: Props) {
  return (
    <div className="flex items-center gap-4 mb-4">
      <select
        value={level}
        onChange={(e) => onLevelChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        <option value="">All levels</option>
        {levels.filter(Boolean).map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Search logs..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 max-w-xs"
      />

      <button
        onClick={onRawToggle}
        className={`px-3 py-1.5 text-sm rounded border ${
          showRaw ? 'border-cyan-500 text-cyan-400' : 'border-gray-700 text-gray-400'
        }`}
      >
        Raw JSON
      </button>
    </div>
  );
}
```

**Step 3: Create Logs page**

`packages/web/client/src/pages/Logs.tsx`:
```tsx
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import LogLine from '../components/LogLine';
import LogFilters from '../components/LogFilters';

interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  error?: string;
  stackTrace?: string;
  extra: Record<string, unknown>;
}

export default function Logs() {
  const { namespace, pod } = useParams<{ namespace: string; pod: string }>();
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (search) params.set('search', search);

  const { data, loading } = useApi<{ logs: ParsedLog[]; total: number }>(
    `/api/pods/${namespace}/${pod}/logs?${params.toString()}`
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Link to="/" className="text-gray-400 hover:text-white text-sm">&larr; Back</Link>
        <h2 className="text-lg font-semibold">
          <span className="text-gray-400">{namespace}/</span>
          <span className="text-cyan-400">{pod}</span>
        </h2>
        {data && (
          <span className="text-xs text-gray-500">
            {data.logs.length}/{data.total} logs
          </span>
        )}
      </div>

      <LogFilters
        level={level}
        search={search}
        showRaw={showRaw}
        onLevelChange={setLevel}
        onSearchChange={setSearch}
        onRawToggle={() => setShowRaw(!showRaw)}
      />

      {loading && <p className="text-gray-500">Loading logs...</p>}

      <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
        {data?.logs.map((log, i) => (
          <LogLine key={i} log={log} showRaw={showRaw} />
        ))}
        {data?.logs.length === 0 && (
          <p className="text-gray-500 text-center py-4">No logs found</p>
        )}
      </div>
    </div>
  );
}
```

**Step 4: Update App.tsx**

Import and use `Logs` component for the `/logs/:namespace/:pod` route.

**Step 5: Build and verify**

```bash
cd packages/web/client && npx vite build
```
Expected: Builds without errors

**Step 6: Commit**

```bash
git add packages/web/client/src/
git commit -m "feat: Logs page with level/search filters and raw toggle"
```

---

### Task 10: Build Stream page (real-time WebSocket logs)

**Files:**
- Create: `packages/web/client/src/hooks/useStream.ts`
- Create: `packages/web/client/src/pages/Stream.tsx`
- Modify: `packages/web/client/src/App.tsx`

**Step 1: Create useStream hook**

`packages/web/client/src/hooks/useStream.ts`:
```tsx
import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  extra: Record<string, unknown>;
}

interface StreamOptions {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
  };
}

const MAX_LOGS = 2000;

export function useStream() {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => {
      setConnected(false);
      setStreaming(false);
    });

    socket.on('stream:log', (log: ParsedLog) => {
      setLogs((prev) => {
        const next = [...prev, log];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    });

    socket.on('stream:error', (err: { podName: string; error: string }) => {
      console.error(`Stream error for ${err.podName}: ${err.error}`);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const start = useCallback((options: StreamOptions) => {
    setLogs([]);
    socketRef.current?.emit('stream:start', options);
    setStreaming(true);
  }, []);

  const stop = useCallback(() => {
    socketRef.current?.emit('stream:stop');
    setStreaming(false);
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, streaming, start, stop, clear };
}
```

**Step 2: Create Stream page**

`packages/web/client/src/pages/Stream.tsx`:
```tsx
import { useState, useRef, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { useStream } from '../hooks/useStream';
import LogLine from '../components/LogLine';

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

export default function Stream() {
  const [namespace, setNamespace] = useState('default');
  const [selectedPods, setSelectedPods] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods } = useApi<Pod[]>(`/api/pods/${namespace}`);
  const { logs, connected, streaming, start, stop, clear } = useStream();

  useEffect(() => {
    if (autoScroll && !paused) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll, paused]);

  const handleStart = () => {
    if (selectedPods.length === 0) return;
    start({ namespace, pods: selectedPods });
  };

  const togglePod = (name: string) => {
    setSelectedPods((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name],
    );
  };

  const selectAll = () => {
    if (!pods) return;
    setSelectedPods(
      selectedPods.length === pods.length ? [] : pods.map((p) => p.name),
    );
  };

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold">Stream</h2>
        <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {!streaming && (
        <div className="mb-4">
          <div className="flex items-center gap-4 mb-3">
            <select
              value={namespace}
              onChange={(e) => { setNamespace(e.target.value); setSelectedPods([]); }}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
            >
              {namespaces?.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
            <button onClick={selectAll} className="text-xs text-gray-400 hover:text-white">
              {selectedPods.length === (pods?.length ?? 0) ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {pods?.map((pod) => (
              <button
                key={pod.name}
                onClick={() => togglePod(pod.name)}
                className={`px-3 py-1 text-xs rounded border font-mono ${
                  selectedPods.includes(pod.name)
                    ? 'border-cyan-500 text-cyan-400 bg-cyan-500/10'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {pod.name}
              </button>
            ))}
          </div>

          <button
            onClick={handleStart}
            disabled={selectedPods.length === 0}
            className="px-4 py-2 bg-cyan-600 text-white rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-cyan-500"
          >
            Start streaming ({selectedPods.length} pods)
          </button>
        </div>
      )}

      {streaming && (
        <div className="flex items-center gap-3 mb-4">
          <button onClick={stop} className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-500">
            Stop
          </button>
          <button
            onClick={() => setPaused(!paused)}
            className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clear} className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600">
            Clear
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <span className="text-xs text-gray-500">{logs.length} logs</span>
        </div>
      )}

      <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
        {logs.map((log, i) => (
          <LogLine key={i} log={log} showRaw={false} />
        ))}
        <div ref={logEndRef} />
        {logs.length === 0 && streaming && (
          <p className="text-gray-500 text-center py-4">Waiting for logs...</p>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Update App.tsx**

Import and use `Stream` component for the `/stream` route.

**Step 4: Build and verify**

```bash
cd packages/web/client && npx vite build
```
Expected: Builds without errors

**Step 5: Commit**

```bash
git add packages/web/client/src/
git commit -m "feat: Stream page with real-time WebSocket logs"
```

---

### Task 11: Build Search page

**Files:**
- Create: `packages/web/client/src/pages/Search.tsx`
- Modify: `packages/web/client/src/App.tsx`

**Step 1: Create Search page**

`packages/web/client/src/pages/Search.tsx`:
```tsx
import { useState } from 'react';
import LogLine from '../components/LogLine';

interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  extra: Record<string, unknown>;
}

export default function Search() {
  const [namespace, setNamespace] = useState('default');
  const [term, setTerm] = useState('');
  const [level, setLevel] = useState('');
  const [results, setResults] = useState<ParsedLog[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!term.trim()) return;
    setLoading(true);
    try {
      // Search across all pods by fetching pods, then logs for each
      const podsRes = await fetch(`/api/pods/${namespace}`);
      const pods: { name: string }[] = await podsRes.json();

      const allLogs: ParsedLog[] = [];
      for (const pod of pods) {
        const params = new URLSearchParams({ search: term });
        if (level) params.set('level', level);
        const res = await fetch(`/api/pods/${namespace}/${pod.name}/logs?${params}`);
        const data: { logs: ParsedLog[] } = await res.json();
        allLogs.push(...data.logs);
      }
      setResults(allLogs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Search</h2>

      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          placeholder="Namespace"
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-32"
        />
        <input
          type="text"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search term..."
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 max-w-md"
        />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
        >
          <option value="">All levels</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <button
          onClick={handleSearch}
          disabled={loading || !term.trim()}
          className="px-4 py-1.5 bg-cyan-600 text-white rounded text-sm disabled:opacity-50 hover:bg-cyan-500"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results !== null && (
        <>
          <p className="text-sm text-gray-400 mb-3">
            {results.length} result{results.length !== 1 ? 's' : ''} for "{term}"
          </p>
          <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
            {results.map((log, i) => (
              <div key={i} className="flex gap-2 items-start">
                {log.podName && (
                  <span className="text-purple-400 font-mono text-xs shrink-0 w-40 truncate">
                    {log.podName}
                  </span>
                )}
                <LogLine log={log} showRaw={false} />
              </div>
            ))}
            {results.length === 0 && (
              <p className="text-gray-500 text-center py-4">No results found</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

**Step 2: Update App.tsx**

Import and use `Search` component for the `/search` route.

**Step 3: Build and verify**

```bash
cd packages/web/client && npx vite build
```
Expected: Builds without errors

**Step 4: Commit**

```bash
git add packages/web/client/src/
git commit -m "feat: Search page with cross-pod full-text search"
```

---

### Task 12: Full integration build and smoke test

**Step 1: Full build from root**

```bash
npm install
npm run build
```
Expected: All packages build (core, cli, web + client)

**Step 2: Verify CLI still works**

```bash
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js contexts
```
Expected: Help output shows all commands, contexts lists available contexts

**Step 3: Verify web starts and serves frontend**

```bash
cd packages/web && node dist/main.js
```
Then open `http://localhost:3000` in a browser.
Expected: React app loads with nav bar, Dashboard shows context/namespace selectors

**Step 4: Verify API endpoints**

```bash
curl http://localhost:3000/api/contexts
curl http://localhost:3000/api/namespaces
```
Expected: JSON responses with contexts and namespaces

**Step 5: Update CLAUDE.md with new structure**

Add the web package info and monorepo structure to the project docs.

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete monorepo migration with NestJS + React web UI"
```

---

Plan complete and saved to `docs/plans/2026-03-05-nestjs-web-ui-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
