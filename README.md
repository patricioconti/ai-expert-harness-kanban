# AI Expert Harness

Capa visual del `feature-flow` de AI Expert. Abre un proyecto, selecciona las features que faltan y sigue el trabajo real de planner → implementer → validator. Sin demo mezclada con ejecuciones reales.

> **Fork de [devexpert-io/ai-expert-harness-kanban](https://github.com/devexpert-io/ai-expert-harness-kanban).** El original sigue intacto: con Pi y DevExpert Inference, todo funciona igual que allí. Este fork añade:
>
> - Un segundo motor, `HARNESS_ENGINE=claude`, que ejecuta los roles con tu suscripción de Claude Code (login de claude.ai, nunca una API key). Ver [Con tu suscripción de Claude Code](#con-tu-suscripción-de-claude-code).
> - Su Claude Code de ensayo (`pnpm dev:ensayo:claude`).
> - `HARNESS_PROJECT`, para abrir el tablero con un proyecto ya seleccionado.
> - Dos reglas nuevas del host, que valen para los dos motores: se cierran los procesos que deja un rol en su worktree, y si el implementer toca la spec, **Continuar** vuelve al planner.

## Arranque

Node 22 o superior, Git y un motor para los roles: Pi (por defecto) o Claude Code con tu suscripción (`HARNESS_ENGINE=claude`, ver más abajo). No necesita dependencias npm. Para revisar en GitHub, además `gh` autenticado.

```sh
pnpm dev
# http://localhost:4173
```

Con Pi, la API key de DevExpert Inference se configura desde la UI (**Configurar API key**): se comprueba contra `/v1/models`, vive en memoria y solo se guarda en disco (`.harness-data/credentials.json`, permisos 600) si marcas *Recordarla*. Nunca vuelve al navegador. También vale `DEVEXPERT_API_KEY` en el entorno (`DEVEXPERT_API_KEY=… pnpm dev`); la de la UI tiene prioridad.

Para ensayar sin inferencia: `pnpm dev:ensayo` usa `examples/mini-harness/fake-pi.mjs`, que habla el protocolo RPC de Pi y hace un trabajo mínimo por rol, con un estado separado en `.harness-data/ensayo/`. Revisa siempre en ramas locales (`HARNESS_REVIEW=local`): un ensayo nunca hace push ni abre PRs, aunque el proyecto tenga un remoto en GitHub.

La versión didáctica, en un archivo con el flujo, las reglas y el bucle, está en [`examples/mini-harness`](examples/mini-harness/README.md).

### Con tu suscripción de Claude Code

```sh
HARNESS_ENGINE=claude pnpm dev
```

Cada rol corre en una sesión `claude -p` (stream-json) con tu login de claude.ai: nunca con una API key. El harness lo garantiza en tres puntos:

- Al proceso de cada rol no llega ninguna variable `ANTHROPIC_*` ni `CLAUDE*` (solo `CLAUDE_CONFIG_DIR` y `CLAUDE_CODE_OAUTH_TOKEN`), así que una clave, un proxy o un proveedor en la nube del entorno no se cuelan.
- La sesión debe informar `apiKeySource: none`; si no, el rol se detiene antes de trabajar.
- `claude auth status` se comprueba al arrancar, antes de cada encolado y con **Comprobar de nuevo** en el tablero. Solo vale un login de claude.ai con el proveedor de Anthropic; sin él no se encola nada y el aviso dice qué falta (por ejemplo, `claude auth login`).

No se usa `claude --bare`, porque ese modo solo acepta `ANTHROPIC_API_KEY`. En su lugar, cada sesión arranca con `--strict-mcp-config --setting-sources project --disable-slash-commands`: sin tus MCP, plugins ni ajustes de usuario. Claude Code carga por su cuenta el `AGENTS.md` del worktree, así que el host solo añade el flujo, las instrucciones del rol y su skill.

| Rol | Modelo | Herramientas permitidas (`--permission-mode dontAsk`) |
| --- | --- | --- |
| planner | sonnet | `Read`, `Glob`, `Grep`, `Edit`, `Write`; `Bash` solo de lectura |
| implementer | opus | lo anterior y `Bash` completo |
| validator | opus | `Read`, `Glob`, `Grep` y `Bash`; sin `Edit` ni `Write` |

Los modelos están fijados en `harness/claude-config.mjs` y no los cambia el entorno. El esfuerzo sale de `model_reasoning_effort` del rol. A los tres se les niegan `git add/commit/push/checkout/switch/reset/...`: una segunda barrera, porque el host sigue comprobando con Git los límites de cada rol. El resultado llega por `StructuredOutput` con un esquema por rol (si falta, se acepta el bloque `<harness-result>` y se recuerda el formato hasta dos veces). Este motor todavía no aplica los `permission` de `.opencode/agents`: con ellos se niega a ejecutar, en vez de ignorarlos.

El consumo sale de la ventana de 5 h y del límite semanal de tu plan. El tablero avisa cuando te acercas; si se agota, la feature queda bloqueada con la hora de renovación y la cola se pausa, para continuar desde ese paso cuando se renueve. Si tu cuenta tiene activado el uso extra de pago, Claude Code puede seguir consumiéndolo en vez de detenerse: revísalo en tu cuenta antes de lanzar una cola larga. Como referencia, una feature mediana de un proyecto Kotlin Multiplatform (Gradle, emulador, tres plataformas) gastó en torno al 14 % de una ventana de 5 h. Empieza con `HARNESS_PARALLEL=1`.

`CLAUDE_BIN` cambia el binario y `CLAUDE_TIMEOUT_MS` el tiempo por rol (30 minutos por defecto). Un implementer que verifica a fondo puede necesitar más: en ese proyecto 30 minutos no alcanzaron y se usaron 90 (`CLAUDE_TIMEOUT_MS=5400000`).

Para ensayar sin suscripción: `pnpm dev:ensayo:claude` usa `examples/mini-harness/fake-claude.mjs`, con su propio estado en `.harness-data/ensayo-claude/`. `FAKE_CLAUDE_LOGIN=out|apikey`, `FAKE_CLAUDE_LIMIT=<rol>` y `FAKE_CLAUDE_CHEAT=validator` ensayan una sesión cerrada, un límite agotado y un validator que escribe.

## Uso

1. **Abrir proyecto…**: selecciona la raíz Git con el selector nativo de macOS. Para abrirlo ya seleccionado, arranca con `HARNESS_PROJECT=/ruta/al/proyecto`; el proyecto debe existir y cumplir el contrato, o el servidor no arranca. El harness detecta cómo se revisa: **GitHub** si `origin` está en GitHub y `gh` está autenticado; si no, **ramas locales**. `HARNESS_REVIEW=local|github` lo fuerza.
2. Marca las features pendientes. Al marcar una se añaden sus dependencias; al desmarcarla se quitan las que dependían de ella.
3. **Ejecutar selección** muestra el orden y lanza la cola. Las features cuyas dependencias ya están integradas avanzan **en paralelo** (`HARNESS_PARALLEL`, 3 por defecto).
4. Cada feature trabaja en su propia rama `feat/<id>` y su propio worktree, creados desde la base actual (`origin/<base>` recién descargada en GitHub). Tu checkout no se toca. Se copian `.env`, `.env.local` y `.env.test` si existen; dependencias y puertos siguen siendo cosa del proyecto. Para proyectos Android, `HARNESS_ANDROID_DEVICES=emulator-5554,R58M123ABC` (seriales de `adb devices`) reparte los dispositivos: cada feature en curso recibe uno libre y conectado en ese momento (según `adb devices`) como `ANDROID_SERIAL` y su prompt lo nombra; si no queda ninguno libre, `ANDROID_SERIAL=none` hace fallar adb y Gradle en vez de compartir dispositivo, y el prompt pide verificar sin dispositivo. El detalle de la tarjeta muestra cuál le tocó.
5. Abre una tarjeta (panel lateral; `Esc` lo cierra y `#<id>` enlaza a ella) para ver rol, skill, actividad de Pi, evidencia, correcciones, archivos y cómo probarlo. La actividad es la del motor elegido.
6. El validator puede aceptar, pedir correcciones o bloquear. Las correcciones vuelven al implementer y se validan otra vez (máximo tres por intento).
7. Tras la aceptación independiente, el host hace el commit en la rama y la publica para **revisión humana**: en GitHub hace push y abre una PR con resumen, evidencia y cómo probarlo; en local la rama queda lista para integrar.
8. **Mergear PR** (squash con `gh`) o **Integrar en <base>** (merge `--no-ff` en tu checkout, que debe estar limpio y en la base) completa la feature. También puedes mergear en GitHub: el tablero consulta las PR cada 20 s (o con **Comprobar PRs**).
9. **Pedir cambios** conserva la rama y la PR y lanza otra vuelta planner → implementer → validator con tu feedback: el planner ajusta la spec (tu feedback puede cambiar lo que la feature debe hacer, y solo él puede tocarla), el implementer la implementa y el validator revalida. Acaba en un commit `fix: address review of <id>` en la misma PR, con tu feedback como comentario.

Una dependencia solo cuenta cuando está **integrada** en la base: nada se construye sobre un cambio que no has revisado. Mientras tanto sus dependientes esperan en cola.

Al integrar una feature, las demás ramas en revisión se actualizan con la base. Los conflictos de estado en `feature_list.json` (fusión por id) y `PROGRESS.md` (unión) se resuelven solos; cualquier otro conflicto se marca en la tarjeta. **Resolver conflictos** se lo encarga a los roles: el harness empieza el merge de la base en la rama, el implementer resuelve las marcas y vuelve a verificar, el validator revisa la resolución y el harness hace un commit de merge `chore: merge <base> into feat/<id>` con dos padres (sin planner, porque la spec no cambia). Si quedan marcas, la feature se bloquea antes del validator. También puedes resolverlo tú en la rama y volver a integrar.

**Pausar cola** deja terminar lo que está en marcha. **Detener ejecución** interrumpe ese rol; el resto sigue. **Continuar desde este paso** conserva baseline y resultados. **Quitar de la cola** conserva rama y worktree para que los revises.

## Fuente de verdad

El repositorio debe incluir:

```text
feature_list.json
AGENTS.md
.agents/skills/{feature-flow,feature-spec,feature-implementer,feature-validator}/SKILL.md
# y los subagentes, en uno de estos dos formatos:
.opencode/agents/{planner,implementer,validator}.md      # OpenCode (la tienda del curso)
.codex/config.toml + .codex/agents/<rol>.toml            # Codex
```

Si existe `.opencode/agents/`, se usa OpenCode: de cada `<rol>.md` se toman las instrucciones (el cuerpo tras el frontmatter) y se comprueba que es `mode: subagent` y que usa la skill de su rol (`$feature-spec`, etc.). Sus `permission` se aplican en Pi con la extensión `harness/opencode-permissions.mjs`: las herramientas que el rol niega del todo no se activan, y el resto se decide antes de cada llamada con las reglas de OpenCode (gana la última que encaja; «ask» se bloquea porque nadie puede responder). En `bash` solo se vigilan las rutas de tu carpeta personal fuera del proyecto: no es un sandbox del sistema. El host sigue comprobando los límites de cada rol por su cuenta. Si no, se leen los `config_file` de `.codex/config.toml` con instrucciones, modelo y esfuerzo. Las referencias de las skills permanecen accesibles al agente y se incluyen en la huella de configuración. No se modifica ni copia configuración dentro del proyecto abierto.

El adaptador rechaza configuraciones incompatibles en vez de inventar un rol. Cada rol usa una sesión Pi nueva, sin extensiones ni contexto global descubierto; recibe explícitamente las instrucciones y la skill del proyecto y la extensión de proveedor de este harness. Pi **no reproduce el sandbox de Codex**: aunque aplique los permisos de OpenCode, ejecuta con los permisos del usuario. Usa solo repositorios de confianza y no edites en paralelo los archivos de la feature activa.

Con Pi, el modelo de ejecución está fijado explícitamente en **DevExpert Inference → `chat`** para los tres roles (`harness/pi-config.mjs`). Se conservan sus instrucciones, skills y esfuerzo de razonamiento, sin modificar la configuración del proyecto objetivo. La UI muestra el modelo efectivo. Ni `PI_MODEL`, ni `PI_PROVIDER`, ni las credenciales presentes en el entorno cambian esa selección; no hay fallback a OpenAI u otro modelo.

La extensión local `harness/devexpert-provider.mjs` registra el alias `chat` de `https://inference.devexpert.io/v1` y usa `$DEVEXPERT_API_KEY`, que le pasa el host (la clave de la UI o la del entorno). No escribe configuración global de Pi ni almacena claves. Su metadata no estima costes del servicio. `PI_BIN` y `PI_TIMEOUT_MS` (30 minutos por rol por defecto) siguen disponibles.

### Contrato único

`feature_list.json` es una lista JSON directa con exactamente estos nueve campos:

```json
[
  {
    "id": "catalog-search",
    "area": "catalog",
    "title": "Buscar productos",
    "user_visible_behavior": "La persona encuentra productos por texto.",
    "depends_on": [],
    "status": "not_started",
    "verification": ["Una búsqueda devuelve las coincidencias esperadas."],
    "evidence": [],
    "notes": "Pendiente de planificación."
  }
]
```

No se aceptan contenedores, alias de campos, IDs que no sean seguros para archivos, dependencias inexistentes ni ciclos. El ciclo ejecutable usa `not_started` → `in_progress` → `passing` → `accepted`, y `blocked` para bloqueos. Las etiquetas históricas `planned`, `planning`, `implementing`, `validating`, `review` y `done` pueden visualizarse, pero solo `accepted` satisface una dependencia de ejecución.

El antiguo `.harness/config.json` es opcional y solo se valida si existe; no selecciona un motor simulado ni puede desactivar la revisión humana. `examples/sample-project` muestra el contrato, no es un proyecto ejecutable con roles.

## Persistencia y límites

- Estado, cola, roles, evidencia y aceptación se guardan atómicamente en `.harness-data/state.json`, fuera del repositorio objetivo. `HARNESS_STATE_PATH` permite otra ubicación. No borres ese estado durante una ejecución.
- Al reiniciar, las ejecuciones activas pasan a interrumpidas y la cola queda pausada. El motor (Pi o Claude Code) se detiene si desaparece su proceso servidor. No se continúa trabajo sin acción explícita.
- Una especificación existente sin prueba de actualidad se revisa con planner. Una feature `passing` con spec pasa a validación independiente.
- Solo el planner cambia la spec. Si el implementer la toca (por ejemplo, para marcar casillas), la ejecución se bloquea conservando la autoría de sus archivos, y **Continuar** vuelve al planner para que la revise.
- Al terminar cada rol, el host cierra los procesos que arrancaron durante ese rol con su carpeta dentro del worktree (un `./gradlew run &`, una app lanzada por el daemon de Gradle) y lo anota en la actividad. Lo que ya tenías abierto ahí no se toca.
- Los worktrees viven en `.harness-data/worktrees/`. Se borran (sin forzar) al integrar o cerrar la revisión; ramas y PR se conservan. Si en un worktree hay archivos staged, cambia HEAD/rama o el diff no se puede aislar, se bloquea el commit. No hay reset ni rollback automático.
- Si falla un hook o la firma de commit, los archivos quedan disponibles para inspección; no se desactiva ese control automáticamente. Resuelve el problema antes de continuar.
- La UI vive en `public/` (módulos ES sin build). El estado se consulta cada 1,2 s con ETag; la vista solo se redibuja por regiones cuando algo cambia.
- El servidor escucha solo en loopback. Rechaza mutaciones desde otros orígenes. No expongas este servidor a Internet.

## Verificación

```sh
pnpm check          # Fixtures Git desechables, sin proveedor, sin red y sin GitHub real
pnpm check:pi       # Protocolo RPC local, sin inferencia

# Opt-in: consume una ejecución real. Copia skills/roles, no modifica el origen.
HARNESS_SOURCE_PROJECT=/ruta/al/proyecto DEVEXPERT_API_KEY=… pnpm check:pi:e2e
```

Las pruebas cubren roles reales del adaptador, ciclo de reparación, paralelo con worktrees, revisión humana (integrar, sincronizar ramas, resolver conflictos y pedir cambios), adaptador de GitHub con gh simulado, API key, motor Claude Code (login, permisos por rol, límite agotado y el Claude Code de ensayo), procesos que dejan los roles, aceptación/commit, recuperación de escrituras interrumpidas, preservación de WIP, cola/dependencias, cancelación, persistencia, errores de proveedor, API HTTP y el modelo de vista de la UI. La prueba real usa una feature mínima en un repositorio temporal y conserva su ruta para inspección.
