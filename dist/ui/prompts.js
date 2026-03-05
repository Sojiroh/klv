import * as readline from 'readline';
import chalk from 'chalk';
export async function select(message, choices) {
    if (choices.length === 0) {
        throw new Error('No choices available');
    }
    if (choices.length === 1) {
        console.log(chalk.gray(`  → Auto-selected: ${choices[0]}`));
        return choices[0];
    }
    console.log(chalk.bold(`\n${message}`));
    choices.forEach((choice, i) => {
        console.log(chalk.gray(`  ${i + 1}) `) + chalk.white(choice));
    });
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(chalk.cyan('\n  → Selecciona (número): '), (answer) => {
            rl.close();
            const idx = parseInt(answer, 10) - 1;
            if (idx >= 0 && idx < choices.length) {
                resolve(choices[idx]);
            }
            else {
                console.log(chalk.yellow('  Selección inválida, usando primera opción'));
                resolve(choices[0]);
            }
        });
    });
}
export async function multiSelect(message, choices) {
    if (choices.length === 0)
        return [];
    if (choices.length === 1) {
        console.log(chalk.gray(`  → Auto-selected: ${choices[0]}`));
        return choices;
    }
    console.log(chalk.bold(`\n${message}`));
    console.log(chalk.gray('  0) Todos'));
    choices.forEach((choice, i) => {
        console.log(chalk.gray(`  ${i + 1}) `) + chalk.white(choice));
    });
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(chalk.cyan('\n  → Selecciona (números separados por coma, 0=todos): '), (answer) => {
            rl.close();
            const trimmed = answer.trim();
            if (trimmed === '0' || trimmed.toLowerCase() === 'all') {
                resolve(choices);
                return;
            }
            const indices = trimmed.split(',').map((s) => parseInt(s.trim(), 10) - 1);
            const selected = indices
                .filter((i) => i >= 0 && i < choices.length)
                .map((i) => choices[i]);
            resolve(selected.length > 0 ? selected : choices);
        });
    });
}
export async function confirm(message, defaultValue = true) {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(chalk.cyan(`${message} [${hint}]: `), (answer) => {
            rl.close();
            if (!answer.trim())
                resolve(defaultValue);
            else
                resolve(answer.trim().toLowerCase().startsWith('y'));
        });
    });
}
