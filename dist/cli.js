#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { KubeClient } from './core/kube-client.js';
import { parseLogLine, matchesFilter } from './core/log-parser.js';
import { formatLog, formatLogSeparator, formatStats } from './ui/formatter.js';
import { select, multiSelect } from './ui/prompts.js';
const VERSION = '0.1.0';
const program = new Command();
program
    .name('klv')
    .description('🔍 Kubernetes Log Viewer — Logs JSON bonitos en tu terminal')
    .version(VERSION)
    .option('--kubeconfig <path>', 'Ruta al kubeconfig', process.env.KUBECONFIG)
    .option('--context <name>', 'Contexto de Kubernetes a usar')
    .option('-n, --namespace <ns>', 'Namespace', 'default');
// ─── COMANDO: contexts ───────────────────────────────────────────
program
    .command('contexts')
    .alias('ctx')
    .description('Listar contextos disponibles del kubeconfig')
    .action(() => {
    const opts = program.opts();
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
});
// ─── COMANDO: use-context ───────────────────────────────────────
program
    .command('use-context [name]')
    .alias('uc')
    .description('Cambiar el contexto por defecto del kubeconfig')
    .action(async (nameArg) => {
    const opts = program.opts();
    const client = new KubeClient(opts.kubeconfig);
    const contexts = client.getContexts();
    const current = client.getCurrentContext();
    let contextName = nameArg;
    if (!contextName) {
        contextName = await select('¿A qué contexto quieres cambiar?', contexts);
    }
    if (contextName === current) {
        console.log(chalk.yellow(`\n  Ya estás en el contexto "${contextName}"\n`));
        return;
    }
    try {
        client.useContext(contextName);
        console.log(chalk.green(`\n  ● Contexto cambiado a "${contextName}"\n`));
    }
    catch (err) {
        console.error(chalk.red(`\n  ✖ ${err.message}\n`));
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
    }
    catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
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
    .option('--level <level>', 'Filtrar por nivel mínimo (DEBUG, INFO, WARN, ERROR)')
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
            podName = await select('¿De qué pod quieres ver logs?', pods.map((p) => p.name));
            const pod = pods.find((p) => p.name === podName);
            if (pod.containers.length > 1 && !container) {
                container = await select('¿De qué container?', pod.containers);
            }
        }
        spinner.start(`Obteniendo logs de ${podName}...`);
        const rawLogs = await client.getLogs({
            namespace: opts.namespace,
            podName,
            container,
            tailLines: parseInt(cmdOpts.tail, 10),
            sinceSeconds: cmdOpts.since ? parseInt(cmdOpts.since, 10) : undefined,
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
        const filter = {};
        if (cmdOpts.level)
            filter.minLevel = cmdOpts.level.toUpperCase();
        if (cmdOpts.search)
            filter.search = cmdOpts.search;
        if (cmdOpts.trace)
            filter.traceId = cmdOpts.trace;
        if (cmdOpts.service)
            filter.service = cmdOpts.service;
        if (cmdOpts.exclude)
            filter.excludePatterns = cmdOpts.exclude.split(',').map((s) => s.trim());
        const filtered = parsed.filter((log) => matchesFilter(log, filter));
        // Stats
        const counts = {
            TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0, UNKNOWN: 0,
        };
        filtered.forEach((log) => counts[log.level]++);
        // Header
        console.log(formatLogSeparator(`${podName} — ${filtered.length}/${parsed.length} logs`));
        console.log(formatStats(counts));
        console.log();
        // Formatear
        const formatOpts = {
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
                    }
                    catch {
                        console.log(log.raw);
                    }
                }
                else {
                    console.log(log.raw);
                }
            });
        }
        else {
            filtered.forEach((log) => {
                console.log(formatLog(log, formatOpts));
            });
        }
        console.log();
    }
    catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
        process.exit(1);
    }
});
// ─── COMANDO: stream ─────────────────────────────────────────────
program
    .command('stream [pods...]')
    .description('Seguir logs en tiempo real de uno o más pods')
    .option('-c, --container <name>', 'Container específico')
    .option('-t, --tail <lines>', 'Líneas iniciales', '20')
    .option('--level <level>', 'Nivel mínimo')
    .option('-s, --search <term>', 'Filtrar por texto')
    .option('--exclude <patterns>', 'Excluir patrones')
    .option('--show-extra', 'Mostrar campos extra', false)
    .option('-d, --deployment <name>', 'Seguir todos los pods de un deployment')
    .action(async (podArgs, cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Conectando...').start();
    try {
        const client = new KubeClient(opts.kubeconfig, opts.context);
        let podNames = podArgs || [];
        // Si se especificó deployment, obtener sus pods
        if (cmdOpts.deployment) {
            spinner.text = `Buscando pods del deployment ${cmdOpts.deployment}...`;
            const pods = await client.getPodsForDeployment(opts.namespace, cmdOpts.deployment);
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
            podNames = await multiSelect('¿Qué pods quieres seguir?', pods.map((p) => p.name));
        }
        else {
            spinner.stop();
        }
        const filter = {};
        if (cmdOpts.level)
            filter.minLevel = cmdOpts.level.toUpperCase();
        if (cmdOpts.search)
            filter.search = cmdOpts.search;
        if (cmdOpts.exclude)
            filter.excludePatterns = cmdOpts.exclude.split(',').map((s) => s.trim());
        const formatOpts = {
            showPodName: podNames.length > 1,
            showExtra: cmdOpts.showExtra,
        };
        console.log(formatLogSeparator(`Streaming ${podNames.length} pod(s) — Ctrl+C para salir`));
        console.log(chalk.gray(`  Pods: ${podNames.join(', ')}`));
        console.log();
        const cleanups = [];
        for (const podName of podNames) {
            const cleanup = await client.streamLogs({
                namespace: opts.namespace,
                podName,
                container: cmdOpts.container,
                follow: true,
                tailLines: parseInt(cmdOpts.tail, 10),
            }, (line, pod) => {
                const parsed = parseLogLine(line, pod);
                if (matchesFilter(parsed, filter)) {
                    console.log(formatLog(parsed, formatOpts));
                }
            }, (err, pod) => {
                console.error(chalk.red(`  ✖ Error en ${pod}: ${err.message}`));
            });
            cleanups.push(cleanup);
        }
        // Cleanup on Ctrl+C
        process.on('SIGINT', () => {
            console.log(chalk.gray('\n\n  Deteniendo streams...'));
            cleanups.forEach((fn) => fn());
            process.exit(0);
        });
        // Mantener el proceso vivo
        await new Promise(() => { });
    }
    catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
        process.exit(1);
    }
});
// ─── COMANDO: search ─────────────────────────────────────────────
program
    .command('search <term>')
    .description('Buscar un término en logs de todos los pods del namespace')
    .option('-t, --tail <lines>', 'Líneas por pod', '200')
    .option('--level <level>', 'Nivel mínimo')
    .option('-l, --label <selector>', 'Filtrar pods por label')
    .action(async (term, cmdOpts) => {
    const opts = program.opts();
    const spinner = ora('Buscando en todos los pods...').start();
    try {
        const client = new KubeClient(opts.kubeconfig, opts.context);
        const pods = await client.getPods(opts.namespace, cmdOpts.label);
        const results = [];
        for (const pod of pods) {
            try {
                const raw = await client.getLogs({
                    namespace: opts.namespace,
                    podName: pod.name,
                    tailLines: parseInt(cmdOpts.tail, 10),
                });
                const lines = raw.split('\n').filter((l) => l.trim());
                const parsed = lines.map((line) => parseLogLine(line, pod.name));
                const filter = {
                    search: term,
                    minLevel: cmdOpts.level?.toUpperCase(),
                };
                const matching = parsed.filter((log) => matchesFilter(log, filter));
                results.push(...matching);
            }
            catch {
                // Skip pods que no se pueden leer
            }
        }
        spinner.stop();
        if (results.length === 0) {
            console.log(chalk.yellow(`\n  No se encontró "${term}" en ${pods.length} pods\n`));
            return;
        }
        console.log(formatLogSeparator(`${results.length} resultados para "${term}"`));
        console.log();
        results.forEach((log) => {
            console.log(formatLog(log, { showPodName: true }));
        });
        console.log();
    }
    catch (err) {
        spinner.fail(chalk.red(`Error: ${err.message}`));
        process.exit(1);
    }
});
program.parse();
