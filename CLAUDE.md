# kube-log-viewer

CLI en TypeScript para ver logs JSON de Kubernetes.

## Stack
- TypeScript + Node.js (ESM)
- @kubernetes/client-node para conexión a clusters
- Commander para CLI, chalk para colores, ora para spinners

## Estructura
- src/cli.ts — Entry point con comandos (contexts, pods, logs, stream, search)
- src/core/kube-client.ts — Wrapper del SDK de K8s, lee kubeconfig
- src/core/log-parser.ts — Parser de logs JSON, reconoce campos comunes
- src/ui/formatter.ts — Output coloreado por level con iconos
- src/ui/prompts.ts — Selector interactivo de pods/containers

## Decisiones de diseño
- Lee el mismo kubeconfig que OpenLens
- Parser genérico que detecta campos de Spring Boot, NestJS, etc.
- Cada pod recibe un color distinto en modo multi-pod
- PassThrough stream para el streaming de logs

## Pendiente
- Modo interactivo con navegación por teclado
- Web UI con NestJS + React