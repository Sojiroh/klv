#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { KubeClient, parseLogLine, parseLevel, matchesFilter, type LogFilter, type LogLevel, type ParsedLog } from '@klv/core';
import { formatLog, formatLogSeparator, formatStats, type FormatOptions } from './ui/formatter.js';
import { select, multiSelect } from './ui/prompts.js';

// dist/cli.js y src/cli.ts viven un nivel por debajo de package.json
const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const VALID_LEVELS = 'TRACE, DEBUG, INFO, WARN, ERROR, FATAL';

// Normaliza --level con el parser del core; un valor desconocido es un error (no desactiva el filtro)
function parseMinLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const level = parseLevel(raw);
  if (level === 'UNKNOWN') {
    throw new Error(`Nivel inválido: "${raw}". Niveles válidos: ${VALID_LEVELS}`);
  }
  return level;
}

const program = new Command();

program
  .name('klv')
  .description('Kubernetes Log Viewer — Logs JSON bonitos en tu terminal')
  .version(VERSION)
  .option('--kubeconfig <path>', 'Ruta al kubeconfig (por defecto: $KUBECONFIG o ~/.kube/config)')
  .option('--context <name>', 'Contexto de Kubernetes a usar')
  .option('-n, --namespace <ns>', 'Namespace', 'default');

// ─── COMANDO: contexts ───────────────────────────────────────────
program
  .command('contexts')
  .alias('ctx')
  .description('Listar contextos disponibles del kubeconfig')
  .action(() => {
    const opts = program.opts();

    try {
      const client = new KubeClient(opts.kubeconfig, opts.context);
      const contexts = client.getContexts();
      const current = client.getCurrentContext();

      console.log(chalk.bold('\n📋 Contextos disponibles:\n'));
      contexts.forEach((ctx) => {
        const marker = ctx === current ? chalk.green(' ● ') : chalk.gray(' ○ ');
        const name = ctx === current ? chalk.greenBright(ctx) : chalk.white(ctx);
        console.log(`${marker}${name}`);
      });
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n  ✖ ${errorMessage(err)}\n`));
      process.exit(1);
    }
  });

// ─── COMANDO: use-context ───────────────────────────────────────
program
  .command('use-context [name]')
  .alias('uc')
  .description('Cambiar el contexto por defecto del kubeconfig')
  .action(async (nameArg) => {
    const opts = program.opts();

    try {
      const client = new KubeClient(opts.kubeconfig);
      const contexts = client.getContexts();
      const current = client.getCurrentContext();

      let contextName = nameArg;

      if (!contextName) {
        contextName = await select(
          '¿A qué contexto quieres cambiar?',
          contexts,
        );
      }

      if (contextName === current) {
        console.log(chalk.yellow(`\n  Ya estás en el contexto "${contextName}"\n`));
        return;
      }

      client.useContext(contextName);
      console.log(chalk.green(`\n  ● Contexto cambiado a "${contextName}"\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ✖ ${errorMessage(err)}\n`));
      process.exit(1);
    }
  });

// ─── COMANDO: pods ───────────────────────────────────────────────
program
  .command('pods')
  .description('Listar pods en un namespace')
  .option('-l, --label <selector>', 'Filtrar por label selector')
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Obteniendo pods...').start();

    try {
      const client = new KubeClient(opts.kubeconfig, opts.context);
      const pods = await client.getPods(opts.namespace, cmdOpts.label);
      spinner.stop();

      if (pods.length === 0) {
        console.log(chalk.yellow(`\n  No se encontraron pods en namespace "${opts.namespace}"\n`));
        return;
      }

      const table = new Table({
        head: ['', 'Pod', 'Status', 'Containers', 'Age'].map((h) => chalk.cyan(h)),
        style: { border: ['gray'] },
      });

      pods.forEach((pod, i) => {
        const statusColor = pod.status === 'Running' ? chalk.green
          : pod.status === 'Pending' ? chalk.yellow
          : chalk.red;
        table.push([
          chalk.gray(`${i + 1}`),
          chalk.white(pod.name),
          statusColor(pod.status),
          chalk.gray(pod.containers.join(', ')),
          chalk.gray(pod.age),
        ]);
      });

      console.log(chalk.bold(`\n📦 Pods en ${chalk.cyan(opts.namespace)}:\n`));
      console.log(table.toString());
      console.log();
    } catch (err) {
      spinner.fail(chalk.red(`Error: ${errorMessage(err)}`));
      process.exit(1);
    }
  });

// ─── COMANDO: logs ───────────────────────────────────────────────
program
  .command('logs [pod]')
  .description('Ver logs de un pod (parseados y coloreados)')
  .option('-c, --container <name>', 'Container específico')
  .option('-t, --tail <lines>', 'Número de líneas', '100')
  .option('--since <seconds>', 'Logs de los últimos N segundos')
  .option('--previous', 'Logs del contenedor anterior (tras un reinicio)', false)
  .option('--level <level>', `Filtrar por nivel mínimo (${VALID_LEVELS})`)
  .option('-s, --search <term>', 'Buscar texto en los logs')
  .option('--service <name>', 'Filtrar por nombre de servicio')
  .option('--trace <id>', 'Filtrar por trace/request ID')
  .option('--exclude <patterns>', 'Excluir patrones (separados por coma)')
  .option('--show-extra', 'Mostrar campos extra del JSON', false)
  .option('--compact', 'Formato compacto', false)
  .option('--no-timestamp', 'Ocultar timestamps')
  .option('--raw', 'Mostrar JSON raw sin formatear', false)
  .action(async (podArg, cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Conectando al cluster...').start();

    try {
      const minLevel = parseMinLevel(cmdOpts.level);
      const client = new KubeClient(opts.kubeconfig, opts.context);

      let podName = podArg;
      let container = cmdOpts.container;

      // Si no se especificó pod, listar y dejar elegir
      if (!podName) {
        spinner.text = 'Obteniendo pods...';
        const pods = await client.getPods(opts.namespace);
        spinner.stop();

        if (pods.length === 0) {
          console.log(chalk.yellow(`\n  No hay pods en "${opts.namespace}"\n`));
          return;
        }

        podName = await select(
          '¿De qué pod quieres ver logs?',
          pods.map((p) => p.name)
        );

        const pod = pods.find((p) => p.name === podName)!;
        if (pod.containers.length > 1 && !container) {
          container = await select(
            '¿De qué container?',
            pod.containers
          );
        }
      }

      spinner.start(`Obteniendo logs de ${podName}...`);

      const rawLogs = await client.getLogs({
        namespace: opts.namespace,
        podName,
        container,
        tailLines: parseInt(cmdOpts.tail, 10),
        sinceSeconds: cmdOpts.since ? parseInt(cmdOpts.since, 10) : undefined,
        previous: cmdOpts.previous,
      });

      spinner.stop();

      const lines = rawLogs.split('\n').filter((l) => l.trim());

      if (lines.length === 0) {
        console.log(chalk.yellow('\n  No se encontraron logs\n'));
        return;
      }

      // Parsear
      const parsed = lines.map((line) => parseLogLine(line, podName));

      // Filtrar
      const filter: LogFilter = {};
      if (minLevel) filter.minLevel = minLevel;
      if (cmdOpts.search) filter.search = cmdOpts.search;
      if (cmdOpts.trace) filter.traceId = cmdOpts.trace;
      if (cmdOpts.service) filter.service = cmdOpts.service;
      if (cmdOpts.exclude) filter.excludePatterns = cmdOpts.exclude.split(',').map((s: string) => s.trim());

      const filtered = parsed.filter((log) => matchesFilter(log, filter));

      // Stats
      const counts: Record<LogLevel, number> = {
        TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0, UNKNOWN: 0,
      };
      filtered.forEach((log) => counts[log.level]++);

      // Header
      console.log(formatLogSeparator(`${podName} — ${filtered.length}/${parsed.length} logs`));
      console.log(formatStats(counts));
      console.log();

      // Formatear
      const formatOpts: Partial<FormatOptions> = {
        showTimestamp: cmdOpts.timestamp !== false,
        showPodName: false, // solo un pod
        showExtra: cmdOpts.showExtra,
        compact: cmdOpts.compact,
      };

      if (cmdOpts.raw) {
        filtered.forEach((log) => {
          if (log.isJson) {
            try {
              const obj = JSON.parse(log.raw);
              console.log(JSON.stringify(obj, null, 2));
            } catch {
              console.log(log.raw);
            }
          } else {
            console.log(log.raw);
          }
        });
      } else {
        filtered.forEach((log) => {
          console.log(formatLog(log, formatOpts));
        });
      }

      console.log();
    } catch (err) {
      spinner.fail(chalk.red(`Error: ${errorMessage(err)}`));
      process.exit(1);
    }
  });

// ─── COMANDO: stream ─────────────────────────────────────────────
program
  .command('stream [pods...]')
  .description('Seguir logs en tiempo real de uno o más pods')
  .option('-c, --container <name>', 'Container específico')
  .option('-t, --tail <lines>', 'Líneas iniciales', '20')
  .option('--level <level>', `Nivel mínimo (${VALID_LEVELS})`)
  .option('-s, --search <term>', 'Filtrar por texto')
  .option('--exclude <patterns>', 'Excluir patrones')
  .option('--show-extra', 'Mostrar campos extra', false)
  .option('-d, --deployment <name>', 'Seguir todos los pods de un deployment')
  .action(async (podArgs, cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Conectando...').start();

    try {
      const minLevel = parseMinLevel(cmdOpts.level);
      const client = new KubeClient(opts.kubeconfig, opts.context);
      let podNames: string[] = podArgs || [];

      // Si se especificó deployment, obtener sus pods
      if (cmdOpts.deployment) {
        spinner.text = `Buscando pods del deployment ${cmdOpts.deployment}...`;
        const pods = await client.getPodsForDeployment(opts.namespace, cmdOpts.deployment);
        if (pods.length === 0) {
          spinner.fail(chalk.red(`El deployment "${cmdOpts.deployment}" no tiene pods en "${opts.namespace}"`));
          process.exitCode = 1;
          return;
        }
        podNames = pods.map((p) => p.name);
      }

      // Si no se especificaron pods, dejar elegir
      if (podNames.length === 0) {
        spinner.text = 'Obteniendo pods...';
        const pods = await client.getPods(opts.namespace);
        spinner.stop();

        if (pods.length === 0) {
          console.log(chalk.yellow(`\n  No hay pods en "${opts.namespace}"\n`));
          return;
        }

        podNames = await multiSelect(
          '¿Qué pods quieres seguir?',
          pods.map((p) => p.name)
        );
      } else {
        spinner.stop();
      }

      const filter: LogFilter = {};
      if (minLevel) filter.minLevel = minLevel;
      if (cmdOpts.search) filter.search = cmdOpts.search;
      if (cmdOpts.exclude) filter.excludePatterns = cmdOpts.exclude.split(',').map((s: string) => s.trim());

      const formatOpts: Partial<FormatOptions> = {
        showPodName: podNames.length > 1,
        showExtra: cmdOpts.showExtra,
      };

      console.log(formatLogSeparator(`Streaming ${podNames.length} pod(s) — Ctrl+C para salir`));
      console.log(chalk.gray(`  Pods: ${podNames.join(', ')}`));
      console.log();

      const cleanups: (() => void)[] = [];

      // Cleanup on Ctrl+C
      process.on('SIGINT', () => {
        console.log(chalk.gray('\n\n  Deteniendo streams...'));
        cleanups.forEach((fn) => fn());
        process.exit(0);
      });

      // Termina cuando todos los streams han finalizado (cierre normal o error)
      let pending = podNames.length;
      let resolveAllDone!: () => void;
      const allDone = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
      });
      const streamFinished = (): void => {
        if (--pending === 0) resolveAllDone();
      };

      for (const podName of podNames) {
        const cleanup = await client.streamLogs(
          {
            namespace: opts.namespace,
            podName,
            container: cmdOpts.container,
            follow: true,
            tailLines: parseInt(cmdOpts.tail, 10),
          },
          {
            onLine: (line, pod) => {
              const parsed = parseLogLine(line, pod);
              if (matchesFilter(parsed, filter)) {
                console.log(formatLog(parsed, formatOpts));
              }
            },
            onError: (err, pod) => {
              console.error(chalk.red(`  ✖ Error en ${pod}: ${err.message}`));
              process.exitCode = 1;
              streamFinished();
            },
            onEnd: (pod) => {
              console.log(chalk.yellow(`  ● Stream finalizado: ${pod}`));
              streamFinished();
            },
          }
        );
        cleanups.push(cleanup);
      }

      await allDone;
    } catch (err) {
      spinner.fail(chalk.red(`Error: ${errorMessage(err)}`));
      process.exit(1);
    }
  });

// ─── COMANDO: search ─────────────────────────────────────────────
program
  .command('search <term>')
  .description('Buscar un término en logs de todos los pods del namespace')
  .option('-t, --tail <lines>', 'Líneas por pod', '200')
  .option('--level <level>', `Nivel mínimo (${VALID_LEVELS})`)
  .option('-l, --label <selector>', 'Filtrar pods por label')
  .action(async (term, cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Buscando en todos los pods...').start();

    try {
      const minLevel = parseMinLevel(cmdOpts.level);
      const client = new KubeClient(opts.kubeconfig, opts.context);
      const pods = await client.getPods(opts.namespace, cmdOpts.label);

      const filter: LogFilter = { search: term };
      if (minLevel) filter.minLevel = minLevel;

      const results: ParsedLog[] = [];
      const failed: { target: string; message: string }[] = [];
      let searched = 0;

      for (const pod of pods) {
        for (const container of pod.containers) {
          try {
            const raw = await client.getLogs({
              namespace: opts.namespace,
              podName: pod.name,
              container,
              tailLines: parseInt(cmdOpts.tail, 10),
            });

            const lines = raw.split('\n').filter((l) => l.trim());
            const parsed = lines.map((line) => parseLogLine(line, pod.name));
            results.push(...parsed.filter((log) => matchesFilter(log, filter)));
            searched++;
          } catch (err) {
            failed.push({ target: `${pod.name}/${container}`, message: errorMessage(err) });
          }
        }
      }

      spinner.stop();

      const printFailures = (): void => {
        if (failed.length === 0) return;
        console.log(chalk.yellow(`\n  ⚠ No se pudieron leer ${failed.length} contenedor(es):`));
        failed.forEach((f) => console.log(chalk.yellow(`    - ${f.target}: ${f.message}`)));
      };

      if (results.length === 0) {
        console.log(chalk.yellow(`\n  No se encontró "${term}" en ${searched} contenedor(es) de ${pods.length} pod(s)`));
        printFailures();
        console.log();
        return;
      }

      console.log(formatLogSeparator(`${results.length} resultados para "${term}"`));
      console.log();

      results.forEach((log) => {
        console.log(formatLog(log, { showPodName: true }));
      });

      printFailures();
      console.log();
    } catch (err) {
      spinner.fail(chalk.red(`Error: ${errorMessage(err)}`));
      process.exit(1);
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(chalk.red(`\n  ✖ ${errorMessage(err)}\n`));
  process.exitCode = 1;
}
