// Lo que el host sabe sin preguntar a nadie: qué ha cambiado en el proyecto, según Git.
import { execFileSync } from 'node:child_process';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

/** Los archivos cambiados respecto al último commit, cada uno con un hash de su contenido. */
export function snapshot(project) {
  const files = git(project, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((line) => line.slice(3));
  const hash = (file) => { try { return git(project, 'hash-object', '--', file); } catch { return 'deleted'; } };
  return new Map(files.map((file) => [file, hash(file)]));
}

/** Lo que ha cambiado desde `before`: lo que ha tocado el último rol, diga lo que diga. */
export function touchedSince(project, before) {
  const now = snapshot(project);
  return [...new Set([...before.keys(), ...now.keys()])].filter((file) => before.get(file) !== now.get(file));
}

/** El commit lo hace el host, solo con los archivos que le pasan. */
export function commit(project, files, message) {
  git(project, 'add', '--', ...files);
  git(project, 'commit', '-q', '-m', message);
  return git(project, 'rev-parse', '--short', 'HEAD');
}
