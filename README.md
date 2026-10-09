# KLV — Kubernetes Log Viewer

Monorepo con CLI y Web UI para ver logs JSON de Kubernetes. Lee tu kubeconfig existente (el mismo que usa OpenLens).

## Estructura

```
packages/
  core/     @klv/core      — Shared: kube-client + log-parser
  cli/      @klv/cli       — CLI interactivo con colores y filtros
  web/      @klv/web       — NestJS API + React frontend
    client/                — React 19 + Vite + Tailwind SPA
  desktop/  @klv/desktop   — App de escritorio con Tauri 2 (Rust + React)
```

## Stack

- **Core**: TypeScript, @kubernetes/client-node
- **CLI**: Commander, chalk, ora, cli-table3
- **Backend**: NestJS, Socket.IO (WebSocket gateway)
- **Frontend**: React 19, Vite, Tailwind CSS, React Router, socket.io-client, @tanstack/react-virtual
- **Desktop**: Tauri 2, Rust, kube-rs, tokio

## Instalacion

Requiere Node.js `>=20.19 <21` o `>=22.12` (el servidor NestJS en CommonJS carga `@klv/core`, que es ESM, via `require()`).

```bash
git clone https://github.com/Sojiroh/klv.git
cd klv
npm install
npm run build
```

## Web UI

```bash
# Iniciar el servidor (sirve API + frontend en http://127.0.0.1:3000)
npm run start -w @klv/web

# Desarrollo (NestJS watch mode)
npm run dev:web

# Desarrollo frontend (Vite dev server con proxy al backend)
npm run dev:client -w @klv/web
```

### Configuracion

El servidor no tiene autenticacion y usa las credenciales de tu kubeconfig, por eso por defecto solo escucha en loopback y solo acepta conexiones WebSocket de origenes conocidos.

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Interfaz donde escucha el servidor. Usa `0.0.0.0` solo si de verdad quieres exponerlo en la red |
| `PORT` | `3000` | Puerto HTTP/WebSocket |
| `KLV_ALLOWED_ORIGINS` | — | Origenes extra (separados por coma) aceptados por el WebSocket, ademas de `localhost`/`127.0.0.1` en `PORT` y el dev server `:5173` |

### Paginas

- **Dashboard** — Selector de contexto/namespace, tabla de pods agrupados por container con status y link a logs agregados
- **Logs** — Visor de logs con filtros por nivel y busqueda, toggle raw JSON, panel de detalle, soporte para logs por pod y por container (agregados multi-pod)
- **Stream** — Streaming en tiempo real via WebSocket, seleccion de pods, auto-scroll, pause/resume
- **Search** — Busqueda full-text en todos los pods de un namespace

### API REST

| Endpoint | Descripcion |
|----------|-------------|
| `GET /api/contexts` | Contextos disponibles y el contexto activo del servidor |
| `PUT /api/contexts/:name` | Cambiar el contexto activo del servidor (solo en memoria, no modifica `~/.kube/config`) |
| `GET /api/namespaces` | Listar namespaces |
| `GET /api/pods/:namespace` | Listar pods |
| `GET /api/deployments/:namespace` | Listar deployments |
| `GET /api/pods/:ns/:pod/logs` | Logs parseados de un pod (query: `container`, `level`, `search`, `tail`, `since`, `limit`, `offset`) |
| `GET /api/pods/:ns/container/:container/logs` | Logs agregados de todos los pods con ese container, ordenados por timestamp de Kubernetes; incluye `pods` y `failedPods` (query: `level`, `search`, `tail`, `since`, `limit`, `offset`) |

Los errores responden `{ statusCode, message }` con el status real (400 parametros invalidos, 403/404 de Kubernetes, 502 si falla el apiserver).

### WebSocket

Eventos Socket.IO para streaming en tiempo real:

- `stream:start` — Iniciar stream (payload: `{ streamId, namespace, pods[], container?, filters? }`); detiene cualquier stream previo del mismo socket
- `stream:stop` — Detener stream
- `stream:log` — Lote de logs parseados `{ streamId, logs[] }` (servidor -> cliente, cada ~100 ms)
- `stream:error` — Error de stream `{ streamId, podName?, error }` (servidor -> cliente)
- `stream:end` — El stream de un pod termino `{ streamId, podName }` (servidor -> cliente)

La app de escritorio emite los mismos eventos (y payloads) via eventos de Tauri.

## Desktop (Tauri)

App de escritorio nativa que reutiliza el frontend de React pero reemplaza NestJS por un backend en Rust via Tauri 2.

```bash
# Desarrollo (inicia Vite + ventana nativa)
npm run dev:desktop

# Build para produccion (genera .deb / .rpm)
npm run build:desktop
```

### Arquitectura

- **Frontend**: Mismo React SPA que la web, con una capa adaptadora (`tauri.ts`) que detecta si corre en Tauri (`window.__TAURI_INTERNALS__`) y redirige las llamadas API al backend Rust via `invoke()`
- **Backend**: Comandos Tauri en Rust que usan `kube-rs` directamente, con streaming via eventos Tauri
- **Log parser**: Reimplementado en Rust (`log_parser.rs`, `log_filter.rs`) con la misma logica que el parser de TypeScript

### Comandos Tauri

| Comando | Descripcion |
|---------|-------------|
| `get_contexts` | Contextos disponibles y el contexto activo |
| `set_context` | Cambiar el contexto activo (solo en memoria, no modifica `~/.kube/config`) |
| `get_namespaces` | Listar namespaces |
| `get_pods` | Listar pods de un namespace |
| `get_deployments` | Listar deployments |
| `get_pod_logs` | Logs parseados de un pod |
| `get_container_logs` | Logs agregados por container |
| `stream_start` | Iniciar stream en tiempo real |
| `stream_stop` | Detener stream |

## CLI

```bash
# Registrar comando global
npm link -w @klv/cli

# O ejecutar directamente
node packages/cli/dist/cli.js
```

### Comandos

```bash
# Ver contextos disponibles
klv contexts

# Cambiar contexto (escribe current-context en tu kubeconfig, igual que kubectl)
klv use-context mi-contexto

# Listar pods
klv -n mi-namespace pods

# Ver logs (interactivo: te deja elegir pod)
klv -n mi-namespace logs

# Ver logs de un pod especifico con filtros
klv -n mi-namespace logs mi-pod --level WARN --search "timeout"

# Filtrar por trace/request ID
klv -n mi-namespace logs mi-pod --trace "abc-123-def"

# Mostrar campos extra del JSON
klv -n mi-namespace logs mi-pod --show-extra

# Ver JSON raw formateado
klv -n mi-namespace logs mi-pod --raw
```

### Streaming en tiempo real

```bash
# Seguir logs de un pod
klv -n mi-namespace stream mi-pod

# Seguir multiples pods
klv -n mi-namespace stream pod-1 pod-2 pod-3

# Seguir todos los pods de un deployment
klv -n mi-namespace stream --deployment mi-servicio

# Stream con filtros
klv -n mi-namespace stream --deployment mi-api --level ERROR
```

### Busqueda global

```bash
# Buscar en TODOS los pods del namespace
klv -n mi-namespace search "connection refused"

# Buscar solo en pods con cierto label
klv -n mi-namespace search "OOM" --label "app=mi-servicio"
```

### Opciones globales

| Flag | Descripcion |
|------|-------------|
| `--kubeconfig <path>` | Ruta al kubeconfig (default: `$KUBECONFIG`, que puede ser una lista, o `~/.kube/config`) |
| `--context <name>` | Contexto de K8s a usar |
| `-n, --namespace <ns>` | Namespace (default: `default`) |

### Opciones de logs

| Flag | Descripcion |
|------|-------------|
| `-c, --container <name>` | Container especifico (si el pod tiene varios) |
| `-t, --tail <lines>` | Ultimas N lineas (default: 100) |
| `--since <seconds>` | Logs de los ultimos N segundos |
| `--level <level>` | Nivel minimo: TRACE, DEBUG, INFO, WARN, ERROR, FATAL |
| `-s, --search <term>` | Buscar texto en mensaje, error, service, extras |
| `--service <name>` | Filtrar por campo service/app del JSON |
| `--trace <id>` | Filtrar por trace_id/request_id |
| `--exclude <patterns>` | Excluir patrones (separados por coma) |
| `--show-extra` | Mostrar campos extra del JSON |
| `--compact` | Formato compacto |
| `--no-timestamp` | Ocultar timestamps |
| `--raw` | Mostrar JSON sin parsear (pretty-printed) |

## Parser de logs

Reconoce automaticamente campos comunes de logs JSON:

- **Level**: `level`, `severity`, `log.level` (plano estilo ECS o anidado), `lvl`, `loglevel`, `log_level`; acepta niveles numericos de pino/bunyan (`30` = INFO, `50` = ERROR) y severidades de GCP (`NOTICE`, `CRITICAL`, `ALERT`, `EMERGENCY`)
- **Message**: `message`, `msg`, `log`, `text`, `body`
- **Timestamp**: `timestamp`, `time`, `ts`, `@timestamp`; los epoch numericos (segundos, ms, µs o ns) se normalizan a ISO 8601
- **Service**: `service`, `service_name`, `app`, `logger`
- **Trace**: `trace_id`, `traceId`, `x-request-id`, `requestId`
- **Error**: `error`, `err`, `exception`
- **Stack**: `stack`, `stackTrace`, `stack_trace`, `error.stack_trace`

En lineas de texto plano el nivel se detecta por `level=...` (logfmt), por la primera palabra de nivel en mayusculas (`INFO`, `WARN`, `ERROR`...) o por palabras como `error`/`exception`.

Compatible con Spring Boot, NestJS, pino, ECS, Go (zap/zerolog), Python (structlog), Google Cloud Logging y cualquier formato JSON con campos similares.

## Scripts

| Script | Descripcion |
|--------|-------------|
| `npm run build` | Build todos los packages |
| `npm run build:core` | Build solo @klv/core |
| `npm run build:cli` | Build solo @klv/cli |
| `npm run build:web` | Build @klv/web (client + NestJS) |
| `npm run build:desktop` | Build app de escritorio Tauri (.deb/.rpm) |
| `npm run dev:web` | NestJS en watch mode |
| `npm run dev:desktop` | Tauri dev (Vite + ventana nativa) |

## Desarrollo

```bash
# Build todo
npm run build

# Desarrollo web (backend)
npm run dev:web

# Desarrollo web (frontend con HMR)
cd packages/web/client && npm run dev

# Desarrollo desktop (Tauri + frontend)
npm run dev:desktop

# Correr CLI sin compilar
npm run dev -w @klv/cli -- -n mi-namespace logs
```

## Tips

- Si usas OpenLens y ya tienes kubeconfig configurado, klv lo lee automatico
- Usa `--exclude "healthcheck,readiness"` para filtrar el ruido de probes
- El comando `search` es util para encontrar errores que no sabes en que pod estan
- La Web UI usa el mismo backend que el CLI, asi que los datos son identicos
- La app de escritorio (Tauri) no necesita el servidor NestJS — conecta directo al cluster via kube-rs
