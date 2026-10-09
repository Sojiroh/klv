import * as readline from 'readline';
import chalk from 'chalk';

const INPUT_CLOSED = 'Entrada cerrada: no se pudo completar la selección';

// Un iterador de líneas conserva las que llegan juntas (input pegado o por pipe) para los reintentos
function openInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt: string): Promise<string> {
      rl.setPrompt(prompt);
      rl.prompt();
      const { value, done } = await lines.next();
      if (done) throw new Error(INPUT_CLOSED);
      return value;
    },
    close: () => rl.close(),
  };
}

export async function select(
  message: string,
  choices: string[]
): Promise<string> {
  if (choices.length === 0) {
    throw new Error('No hay opciones disponibles');
  }
  if (choices.length === 1) {
    console.log(chalk.gray(`  → Auto-seleccionado: ${choices[0]}`));
    return choices[0];
  }

  console.log(chalk.bold(`\n${message}`));
  choices.forEach((choice, i) => {
    console.log(chalk.gray(`  ${i + 1}) `) + chalk.white(choice));
  });

  const input = openInput();

  try {
    for (;;) {
      const answer = (await input.ask(chalk.cyan('\n  → Selecciona (número): '))).trim();
      const idx = /^\d+$/.test(answer) ? parseInt(answer, 10) - 1 : -1;
      if (idx >= 0 && idx < choices.length) return choices[idx];
      console.log(chalk.yellow(`  Selección inválida: introduce un número entre 1 y ${choices.length}`));
    }
  } finally {
    input.close();
  }
}

export async function multiSelect(
  message: string,
  choices: string[]
): Promise<string[]> {
  if (choices.length === 0) return [];
  if (choices.length === 1) {
    console.log(chalk.gray(`  → Auto-seleccionado: ${choices[0]}`));
    return choices;
  }

  console.log(chalk.bold(`\n${message}`));
  console.log(chalk.gray('  0) Todos'));
  choices.forEach((choice, i) => {
    console.log(chalk.gray(`  ${i + 1}) `) + chalk.white(choice));
  });

  const input = openInput();

  try {
    for (;;) {
      const answer = (await input.ask(chalk.cyan('\n  → Selecciona (números separados por coma, 0=todos): '))).trim();
      if (answer === '0' || answer.toLowerCase() === 'all') return choices;

      const indices = answer.split(',').map((s) => (/^\d+$/.test(s.trim()) ? parseInt(s.trim(), 10) - 1 : -1));
      if (indices.every((i) => i >= 0 && i < choices.length)) {
        return [...new Set(indices)].map((i) => choices[i]);
      }
      console.log(chalk.yellow(`  Selección inválida: usa números entre 1 y ${choices.length} separados por coma, o 0 para todos`));
    }
  } finally {
    input.close();
  }
}

export async function confirm(message: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const input = openInput();

  try {
    const answer = (await input.ask(chalk.cyan(`${message} [${hint}]: `))).trim();
    return answer ? answer.toLowerCase().startsWith('y') : defaultValue;
  } finally {
    input.close();
  }
}
