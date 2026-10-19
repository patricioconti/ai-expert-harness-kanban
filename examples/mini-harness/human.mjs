// Lo que decide una persona. Por ejemplo, aprobar la spec antes de que nadie implemente:
//   import { ask } from './human.mjs';
//   planner: async () => ((await ask('¿Apruebas la spec?')) ? 'implementer' : 'stop'),
import { createInterface } from 'node:readline';

// Una sola lectura de la consola para todas las preguntas, para no perder respuestas entre una y otra.
let terminal;
let lines;

export async function ask(question) {
  terminal ??= createInterface({ input: process.stdin, output: process.stdout });
  lines ??= terminal[Symbol.asyncIterator]();
  terminal.resume();
  terminal.setPrompt(`${question} (s/n) `);
  terminal.prompt();
  const { value = '' } = await lines.next();
  terminal.pause(); // que el harness pueda terminar sin esperar más teclado
  return /^s/i.test(value.trim());
}
