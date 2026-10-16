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
- **Frontend**: React 19, Vite, Tailwind CSS (tema claro estilo Datadog), React Router, socket.io-client, @tanstack/react-virtual
- **Desktop**: Tauri 2, Rust, kube-rs, tokio

## Instalacion

Requiere Node.js `>=22.13` (el servidor carga `@klv/core`, que es ESM, via `require()`) y el binding nativo de DuckDB (`@duckdb/node-api`, con binarios precompilados para Linux/macOS/Windows x64/arm64) para el historial local. Los builds de escritorio compilan libduckdb: la primera compilacion de Rust tarda varios minutos.

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
| `KLV_DATA_DIR` | `~/.klv` | Carpeta donde se guarda el historial local (`config.json`, `history.duckdb`, `segments/`) |

### Paginas

- **Dashboard** — Selector de contexto/namespace, tabla de pods agrupados por container con status, reinicios, link a logs agregados y a los logs del contenedor anterior
- **Logs** — Log Explorer de un pod o de un container agregado (multi-pod)
- **Search** — Log Explorer sobre todos los pods de un namespace (opcionalmente filtrado por container)
- **Stream** — Live tail via WebSocket con buffer configurable (2k–50k lineas) y el mismo query language, facetas, columnas y export sobre el buffer
- **History** — Log Explorer sobre el historial local guardado por el recolector, y configuracion de targets, retencion y estado del recolector

### Log Explorer

- **Query language** estilo Datadog, compartible via URL (`?q=...&range=1h&cols=...`)
- **Facetas** con conteos por level, pod, container, service, env, version y atributos JSON; click para incluir, alt-click para excluir
- **Histograma** de volumen por nivel con selector de rango (15m, 1h, 4h, 24h, 7d, 30d o custom) y zoom arrastrando
- **Columnas configurables** (incluye atributos `@campo`) y **export** a CSV/JSON
- **Patrones**: agrupa mensajes similares (numeros, IDs, UUIDs, IPs, timestamps normalizados) con conteo por nivel
- **Ver en contexto** (lineas alrededor en el mismo pod) y navegacion por `traceId`
- **Logs del contenedor anterior** (`previous`) para diagnosticar CrashLoopBackOff

Sintaxis del query:

| Ejemplo | Significado |
|---------|-------------|
| `timeout` / `"connection refused"` | Texto libre (sin distinguir mayusculas) en `message`, `error` y `stack` (como Datadog); para otros campos usa `campo:valor` y para atributos `@campo:valor` |
| `time*out` | Comodin |
| `level:error`, `level:>=warn` | Nivel exacto o minimo (alias `status:`) |
| `service:api-*`, `env:prod`, `version:1.2.3`, `pod:web-1`, `container:app`, `namespace:prod`, `trace:abc`, `span:x`, `caller:main.go*`, `message:hola`, `error:*` | Campos reservados (`field:*` = existe). Los tags de Datadog `@dd.trace_id:`/`dd.trace_id:`, `dd.span_id:`, `dd.service:`, `dd.env:` y `dd.version:` son alias de los campos reservados |
| `@http.status:500`, `@user.id:*`, `@duration:>500`, `@http.status:[500 TO 599]` | Atributos JSON (ruta con puntos), comparaciones y rangos numericos |
| `-healthcheck`, `NOT service:api`, `(a OR b) AND c` | Negacion, `AND` implicito, `OR` y parentesis |

### Historial local (retencion)

El recolector sigue continuamente los pods de los targets configurados (contexto + namespace + `containers` y/o label selector opcionales; `containers` es una lista, vacia = todos los containers, y en la UI se elige con un selector de checkboxes que consulta los containers del namespace), reconecta tras reinicios y rollouts, y guarda los logs en DuckDB + segmentos Parquet por hora comprimidos con zstd en `$KLV_DATA_DIR/segments/` (o `~/.klv/segments/`). `history.duckdb` contiene solo la hora en curso y los metadatos; `config.json` guarda los targets y la retencion. La retencion se limita por dias y por tamaño (por defecto 7 dias y 1 GB) y borra archivos enteros, asi que es instantanea y no bloquea el servidor. El tamaño en disco es aprox. 1/8–1/15 del volumen crudo de logs JSON. Solo recolecta mientras el servidor (o la app de escritorio) esta corriendo.

Cada target admite filtros opcionales aplicados antes de guardar:

- `minLevel`: nivel minimo a guardar (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`); las lineas sin nivel (continuaciones de stack traces, texto plano) se conservan
- `exclude`: lista de patrones (1–20, hasta 200 caracteres); se descarta la linea si el mensaje contiene alguno como substring (distingue mayusculas)

Al arrancar con un `history.db` de la version anterior (SQLite) se migran los targets y la retencion a `config.json` y se descartan los logs antiguos.

### API REST

| Endpoint | Descripcion |
|----------|-------------|
| `GET /api/contexts` | Contextos disponibles y el contexto activo del servidor |
| `PUT /api/contexts/:name` | Cambiar el contexto activo del servidor (solo en memoria, no modifica `~/.kube/config`) |
| `GET /api/namespaces` | Listar namespaces |
| `GET /api/pods/:namespace` | Listar pods |
| `GET /api/containers/:namespace` | Nombres de container distintos y ordenados de los pods del namespace (query: `context`, `label`) |
| `GET /api/deployments/:namespace` | Listar deployments |
| `GET /api/pods/:ns/:pod/logs` | Logs parseados de un pod (query: `container`, `level`, `search`, `tail`, `since`, `limit`, `offset`, `previous`) |
| `GET /api/pods/:ns/container/:container/logs` | Logs agregados de todos los pods con ese container, ordenados por timestamp de Kubernetes; incluye `pods` y `failedPods` (query: `level`, `search`, `tail`, `since`, `limit`, `offset`, `previous`) |
| `GET /api/history/config` / `PUT /api/history/config` | Targets del recolector (cada uno con `containers`, `minLevel` y `exclude` opcionales; el `container` legado se sigue aceptando) y retencion |
| `GET /api/history/status` | Estadisticas del historial y estado de cada target |
| `POST /api/history/query` | Consultar el historial (`{ namespace?, pods?, containers?, from?, to?, query?, limit?, before? }`, `query` es el AST del query language) |
| `POST /api/history/clear` | Borrar el historial |

Los `POST`/`PUT` de `/api/history` requieren `Content-Type: application/json`.

Los errores responden `{ statusCode, message }` con el status real (400 parametros invalidos, 403/404 de Kubernetes, 502 si falla el apiserver).

### WebSocket

Eventos Socket.IO para streaming en tiempo real:

- `stream:start` — Iniciar stream (payload: `{ streamId, namespace, pods[], container? }`); detiene cualquier stream previo del mismo socket. El filtrado se hace en el cliente con el query language
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
- **Log parser y query language**: Reimplementados en Rust (`log_parser.rs`, `query.rs`) con la misma semantica que `@klv/core`
- **Historial local**: mismo recolector, API y formato de almacenamiento que la web (DuckDB + segmentos Parquet, crate `duckdb` fijado a 1.4.2), en la carpeta de datos de la app. La primera compilacion de Rust tarda varios minutos porque compila libduckdb

### Comandos Tauri

| Comando | Descripcion |
|---------|-------------|
| `get_contexts` | Contextos disponibles y el contexto activo |
| `set_context` | Cambiar el contexto activo (solo en memoria, no modifica `~/.kube/config`) |
| `get_namespaces` | Listar namespaces |
| `get_pods` | Listar pods de un namespace |
| `get_containers` | Listar containers distintos de un namespace |
| `get_deployments` | Listar deployments |
| `get_pod_logs` | Logs parseados de un pod |
| `get_container_logs` | Logs agregados por container |
| `stream_start` | Iniciar stream en tiempo real |
| `stream_stop` | Detener stream |
| `history_get_config` / `history_set_config` | Targets del recolector y retencion |
| `history_status` | Estadisticas y estado del recolector |
| `history_query` | Consultar el historial local |
| `history_clear` | Borrar el historial |
| `export_save` | Guardar un export (CSV/JSON) con el dialogo nativo |

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
| `--previous` | Logs del contenedor anterior (antes del ultimo reinicio) |

## Parser de logs

Reconoce automaticamente campos comunes de logs JSON:

- **Level**: `level`, `severity`, `log.level` (plano estilo ECS o anidado), `lvl`, `loglevel`, `log_level`, y como ultimo recurso `status` (solo texto, p. ej. `"status":"error"`; si es numerico se trata como codigo HTTP y se ignora); acepta niveles numericos de pino/bunyan (`30` = INFO, `50` = ERROR) y severidades de GCP (`NOTICE`, `CRITICAL`, `ALERT`, `EMERGENCY`)
- **Message**: `message`, `msg`, `log`, `text`, `body`
- **Timestamp**: `timestamp`, `time`, `ts`, `@timestamp`; los epoch numericos (segundos, ms, µs o ns) se normalizan a ISO 8601
- **Service**: `service`, `dd.service`, `service_name`, `app`, `logger`
- **Env**: `dd.env`, `dd_env`, `env`
- **Version**: `dd.version`, `dd_version`, `version`
- **Trace**: `dd.trace_id` (plano o anidado en `dd`), `dd_trace_id`, `trace_id`, `traceId`, `x-request-id`, `requestId`
- **Span**: `dd.span_id`, `span_id`, `spanId`
- **Error**: `error`, `err`, `exception`
- **Stack**: `stack`, `stackTrace`, `stack_trace`, `error.stack_trace`

Los tags que inyecta el tracer de Datadog (`dd.trace_id`, `dd.span_id`, `dd.service`, `dd.env`, `dd.version`) se mapean a estos campos y se eliminan de los atributos extra.

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
