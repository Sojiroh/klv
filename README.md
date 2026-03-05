# 🔍 klv — Kubernetes Log Viewer

CLI para ver logs JSON de Kubernetes de forma bonita y organizada. Lee tu kubeconfig existente (el mismo que usa OpenLens).

## Instalación

```bash
# Clonar e instalar
git clone <tu-repo>/kube-log-viewer.git
cd kube-log-viewer
npm install
npm run build
npm link  # Esto registra el comando "klv" globalmente
```

## Uso rápido

```bash
# Ver contextos disponibles
klv contexts

# Listar pods de un namespace
klv -n mi-namespace pods

# Ver logs de un pod (interactivo: te deja elegir)
klv -n mi-namespace logs

# Ver logs de un pod específico
klv -n mi-namespace logs mi-pod-abc123

# Filtrar por nivel
klv -n mi-namespace logs mi-pod --level WARN

# Buscar texto en logs
klv -n mi-namespace logs mi-pod --search "timeout"

# Filtrar por trace/request ID
klv -n mi-namespace logs mi-pod --trace "abc-123-def"

# Mostrar campos extra del JSON
klv -n mi-namespace logs mi-pod --show-extra

# Ver JSON raw formateado
klv -n mi-namespace logs mi-pod --raw
```

## Streaming en tiempo real

```bash
# Seguir logs de un pod
klv -n mi-namespace stream mi-pod

# Seguir múltiples pods
klv -n mi-namespace stream pod-1 pod-2 pod-3

# Seguir todos los pods de un deployment
klv -n mi-namespace stream --deployment mi-servicio

# Stream con filtros
klv -n mi-namespace stream --deployment mi-api --level ERROR --search "NullPointer"
```

## Búsqueda global

```bash
# Buscar en TODOS los pods del namespace
klv -n mi-namespace search "connection refused"

# Buscar solo en pods con cierto label
klv -n mi-namespace search "OOM" --label "app=mi-servicio"
```

## Opciones globales

| Flag | Descripción |
|------|-------------|
| `--kubeconfig <path>` | Ruta al kubeconfig (default: `$KUBECONFIG` o `~/.kube/config`) |
| `--context <name>` | Contexto de K8s a usar |
| `-n, --namespace <ns>` | Namespace (default: `default`) |

## Opciones de logs

| Flag | Descripción |
|------|-------------|
| `-c, --container <name>` | Container específico (si el pod tiene varios) |
| `-t, --tail <lines>` | Últimas N líneas (default: 100) |
| `--since <seconds>` | Logs de los últimos N segundos |
| `--level <level>` | Nivel mínimo: TRACE, DEBUG, INFO, WARN, ERROR, FATAL |
| `-s, --search <term>` | Buscar texto en mensaje, error, service, extras |
| `--service <name>` | Filtrar por campo service/app del JSON |
| `--trace <id>` | Filtrar por trace_id/request_id |
| `--exclude <patterns>` | Excluir patrones (separados por coma) |
| `--show-extra` | Mostrar campos extra del JSON |
| `--compact` | Formato compacto |
| `--no-timestamp` | Ocultar timestamps |
| `--raw` | Mostrar JSON sin parsear (pretty-printed) |

## Qué parsea

El parser reconoce automáticamente campos comunes de logs JSON:

- **Level**: `level`, `severity`, `log.level`, `lvl`
- **Message**: `message`, `msg`, `log`, `text`
- **Timestamp**: `timestamp`, `time`, `ts`, `@timestamp`
- **Service**: `service`, `service_name`, `app`, `logger`
- **Trace**: `trace_id`, `traceId`, `x-request-id`, `requestId`
- **Error**: `error`, `err`, `exception`
- **Stack**: `stack`, `stackTrace`, `stack_trace`

Todo lo que no sea un campo conocido aparece como "extra" con `--show-extra`.

## Ejemplo de output

```
──────── mi-api-7b4f9-x2k4f — 42/100 logs ────────
● INFO: 35 │ ▲ WARN: 5 │ ✖ ERROR: 2

10:30:01.234 ● INFO  Request received: GET /api/health
10:30:01.567 ● INFO  (auth-service) Token validated successfully
10:30:02.890 ▲ WARN  (db-pool) Connection pool reaching limit: 45/50
10:30:03.123 ✖ ERROR Request failed: POST /api/orders
  ↳ Connection timeout after 30000ms
```

## Tips

- Si usas OpenLens y ya tienes kubeconfig configurado, `klv` lo lee automático
- Usa `--exclude "healthcheck,readiness"` para filtrar el ruido de probes
- El comando `search` es útil para encontrar errores que no sabes en qué pod están
- Combina con pipes: `klv -n prod logs mi-pod --raw | jq '.field'`

## Desarrollo

```bash
# Correr sin compilar
npm run dev -- -n mi-namespace logs

# Build
npm run build
```
