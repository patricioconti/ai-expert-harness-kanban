// Tu harness: el proceso de desarrollo, escrito en código.
//   node harness.mjs [feature]                 con Pi real (sin feature: la siguiente lista)
//   node harness.mjs [feature] --rehearsal     con el Pi de ensayo: segundos y sin gastar modelo
//   node harness.mjs [feature] --cheat <rol>   el Pi de ensayo hace trampa en ese rol: ¿qué regla lo para?
//   node harness.mjs [feature] --until <rol>   para después de ese rol (por ejemplo, solo el planner)
import { fileURLToPath } from 'node:url';
import { commit, snapshot, touchedSince } from './git.mjs';
import { launchRole, useRehearsalPi } from './pi.mjs';
import { features, markAccepted, nextReady, start, statusOf } from './project.mjs';

// 1 · El flujo: quién va después lo decide esta tabla, no una skill.
export const next = {
  planner: () => 'implementer',
  implementer: () => 'validator',
  validator: (result) => (result.verdict === 'accept' ? 'commit' : 'implementer'),
};

// 2 · Las reglas: lo que en el módulo 4 era una frase en una skill. El host las comprueba después de cada rol.
export const rules = {
  planner: [
    ['solo toca su spec', (c) => c.touched.every((file) => file === c.spec)],
  ],
  implementer: [
    ['no cambia la spec', (c) => !c.touched.includes(c.spec)],
    ['deja la feature en passing', (c) => c.status === 'passing'],
  ],
  validator: [
    ['no modifica nada', (c) => c.touched.length === 0],
  ],
  all: [
    ['declara todo lo que cambia', (c) => c.touched.every((file) => c.result.files.includes(file))],
  ],
};

const maxSteps = 7; // el planner y tres rondas de implementer y validator; si no basta, decide una persona

// 3 · El bucle: lanzar el rol, comprobar sus reglas y pasar al siguiente.
export async function runFeature(project, feature) {
  const spec = `docs/specs/${feature.id}.md`;
  const touchedByRoles = new Set();
  let role = 'planner';
  let result = null;
  let steps = 0;
  while (role !== 'commit' && role !== 'stop') {
    if (++steps > maxSteps) throw new Error(`${maxSteps} pasos sin terminar: decide una persona`);
    const before = snapshot(project);
    result = await launchRole(project, role, feature, result);
    const touched = touchedSince(project, before);
    const c = { touched, result, spec, status: statusOf(project, feature.id) };
    const applicable = [...(rules[role] ?? []), ...rules.all];
    for (const [rule, passes] of applicable) {
      if (!passes(c)) throw new Error(`${role}: ${rule} (ha tocado: ${touched.join(', ') || 'nada'})`);
    }
    console.log(`  ✓ ${applicable.map(([rule]) => rule).join(' · ')}`);
    if (result.outcome === 'block' || result.verdict === 'block') throw new Error(`${role} bloquea: ${result.summary}`);
    touched.forEach((file) => touchedByRoles.add(file));
    role = await next[role](result);
  }
  if (role === 'stop') return null;
  markAccepted(project, feature.id, result.summary); // la aceptación la escribe el host, nunca un rol
  return commit(project, [...touchedByRoles, 'feature_list.json'], `feat: complete ${feature.id}`); // solo lo de esta feature
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { copy, args } = start();
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const cheat = option('--cheat');
  const until = option('--until');
  if (args.includes('--rehearsal') || cheat) useRehearsalPi({ cheat });
  if (until) next[until] = () => 'stop'; // cambiar el proceso es cambiar la tabla
  const id = args.find((arg) => !arg.startsWith('--') && arg !== cheat && arg !== until);
  const feature = id ? features(copy).find((item) => item.id === id) : nextReady(copy);
  if (!feature) { console.error(id ? `No existe la feature ${id}` : 'No quedan features listas'); process.exit(1); }
  try {
    const hash = await runFeature(copy, feature);
    console.log(hash ? `\n✔ ${feature.id} aceptada · commit ${hash}\nCompruébalo: git -C ${copy} show --stat HEAD` : `\n■ El flujo ha parado antes del commit. Lo hecho está en ${copy}`);
  } catch (error) {
    console.log(`\n✕ ${error.message}\nEl host para aquí: no hay commit. Lo hecho está en ${copy}`);
    process.exitCode = 1;
  }
}
