/**
 * MyJarbis v0.1 → v0.2 auto-migration
 *
 * Detects a project initialized with v0.1 (markdown-based, no memory.db)
 * and turns it into a v0.2 project (SQLite + FTS5):
 *
 * 1. Backup the existing .myjarbis/ folder under ~/.myjarbis-global/backups/
 * 2. Open memory.db (creates it + applies schema via MyJarbisDB.open)
 * 3. Create the project row + a "_general" module + a synthetic session
 * 4. Import legacy markdown context:
 *      - .myjarbis/context/project-summary.md → project_context (functional_spec)
 *      - .myjarbis/prompts/system.md          → project_context (convention)
 *      - .myjarbis/context/knowledge-base.md  → observations under _general
 *      - .myjarbis/context/daily.md           → module_context (workflow)
 * 5. Seed the 6 baseline skills as project-level rows
 * 6. Bump settings.json to v0.2 schema (preserving project name + framework)
 *
 * Idempotent: if memory.db already exists the function returns
 * `{ migrated: false }` immediately. If it does NOT exist but the
 * project also has no .myjarbis/ folder we return `{ migrated: false }`
 * (nothing to migrate — caller should run `myjarbis init` instead).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MyJarbisDB } from './index.js';
import { SCHEMA_VERSION } from './schema.js';

export interface MigrationResult {
  migrated: boolean;
  fromVersion: number | null;
  toVersion: number;
  reason?: string;
  backupPath?: string;
  details?: {
    projectId: number;
    moduleId: number;
    contextEntries: number;
    observations: number;
    skills: number;
  };
}

interface LegacySettings {
  project?: { name?: string; framework?: string; initialized?: string };
  mcp?: { enabled?: boolean };
  context?: { autoGenerateCodebase?: boolean; maxCodebaseSize?: string };
  [k: string]: unknown;
}

interface V02Settings {
  version: '0.2.0';
  project: { name: string; framework: string | null };
  shared: boolean;
  search_default_scope: 'module' | 'project';
  story_pattern: string;
  auto_module_select_when_single: boolean;
  skills: {
    materialize_on_session_start: boolean;
    cleanup_module_skills_on_session_end: boolean;
  };
}

interface KnowledgeEntry {
  date: string;
  title: string;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────
// Baseline skills (Phase 3 replaces the placeholder content with the
// real SKILL.md authored under global/templates/skills/<name>/SKILL.md;
// re-running migrate or init will UPDATE these rows because the hash
// changes).
// ─────────────────────────────────────────────────────────────────────

interface BaselineSkill {
  name: string;
  description: string;
  triggerPattern: string;
  content: string;
}

const BASELINE_SKILLS: BaselineSkill[] = [
  {
    name: 'module-orchestration',
    description: 'Choose/create a module at session start; switch when the context changes',
    triggerPattern: 'session start, /module, /jarbis, project entry',
    content: `---
name: module-orchestration
description: Choose or create a module at session start; switch when the working context changes
---

# Module orchestration

When a Claude session starts in a MyJarbis project:

1. Call \`list_modules\` to see the verticals.
2. If exactly one module exists, select it.
3. If several exist, ask the user which one.
4. If none exist, ask the user to create one with \`create_module\`.

When the user pivots to a different vertical mid-session:

1. Confirm before switching ("vamos a tocar PageBuilder, ¿paso de módulo?").
2. \`end_session\` on the current module with a summary + next_session line.
3. \`start_session\` on the target module so its skills are materialized.

Never operate without an active session — every \`save_observation\` requires one.

## Triggers conversacionales para switch de módulo

Cuando el user dice cualquiera de estos, asumí que quiere cambiar de módulo:
- "vamos a tocar X" / "cambiamos a X" / "pasamos a X" / "ahora X" / "trabajemos en X"
- "ya terminé acá, vamos a Y"
- Un nombre de módulo aislado distinto al activo, sin más contexto.

Flujo:
1. Confirmá: "Cambiamos del módulo <actual> a <X>?"
2. Si sí y hay sesión abierta: pedile summary + next_session, llamá \`end_session\`.
3. Llamá \`start_session(X)\`. Los hooks re-materializan skills.
4. Surface el \`previousSession.nextSession\` del nuevo módulo si existe.

Si el user menciona un módulo que no existe: ofrecé crearlo con
\`create_module(name, description?)\` — preguntale el rol/scope corto
para llenar la description.
`,
  },
  {
    name: 'session-protocol',
    description: 'When to call start_session/end_session and how to format summary + next_session',
    triggerPattern: 'session lifecycle, /jarbis, /complete, end of work',
    content: `---
name: session-protocol
description: Lifecycle of a MyJarbis session and the format of summary + next_session
---

# Session protocol

\`start_session\` is automatic from the SessionStart hook. You only call it
explicitly if the hook didn't (e.g. \`/module switch\`).

\`end_session(summary, next_session)\` is called from \`/complete\` or when the
user signals end of work. Format:

- **summary**: 1–3 bullet sentences with what was implemented/decided. No fluff.
- **next_session**: a "Retomar aquí" block — the *first action* the next session
  should take, with enough context to start without re-reading the codebase.

Example next_session:

> Story MM-S1.3 lista para auditoría. Próxima sesión: correr \`sail artisan test --filter=MediaManager\`, abrir PR a \`MediaManager\`, y empezar MM-S1.4 (migración \`asset_translations\`).

## Triggers conversacionales para \`end_session\`

Cuando el user dice cualquiera de estos, ofrecé cerrar la sesión:
- "listo" / "ya está" / "cerralo" / "terminé" / "done"
- "dale guardalo" / "guardá esto y cerramos"
- "hasta acá llegamos" / "a otra cosa"

**SIEMPRE confirmá antes de llamar \`end_session\`** porque "listo" puede
ser ambiguo (puede significar "terminé esta línea" sin querer cerrar
toda la sesión). Formato de confirmación:

> Cerramos la sesión con:
>   summary: <propuesto, 1-3 bullets>
>   next_session: <propuesto, action-oriented>
> ¿OK o ajustás algo?

Si el user no te dio el contenido, proponé vos uno basado en lo que
viste en la sesión y dejalo editar.
`,
  },
  {
    name: 'observation-protocol',
    description: 'When to save decision vs gotcha vs progress; canonical format',
    triggerPattern: 'after a decision is taken, after a bug is solved, after closing a story',
    content: `---
name: observation-protocol
description: When to save observations and how to type them
---

# Observation protocol

Call \`save_observation\` proactively (don't wait for the user to ask) when ANY
of these happen:

- **decision**: an architecture / library / pattern choice that future sessions
  must respect.
- **gotcha**: a non-obvious fact discovered (a bug, an undocumented behavior,
  a config that bit you).
- **progress**: a story or milestone closed. Include \`story_local_id\` if
  applicable, plus the \`next_session\` text in the matching \`end_session\`.
- **error**: an issue that surfaced and is still open.
- **discovery**: a finding about the codebase worth remembering.

Format:
- **title**: imperative, ≤ 80 chars.
- **content**: WHY first, then WHAT, then HOW.
- **files**: comma-separated list of paths touched, if any.
- **tags**: free-form, used for grouping in search.

## Triggers conversacionales

Saltá al \`save_observation\` correcto cuando oigas:

| El user dice…                                    | kind        |
|--------------------------------------------------|-------------|
| "decidí X" / "decidimos Y" / "vamos con Z"       | decision    |
| "encontré que / falla / quedó este bug raro / ojo con" | gotcha      |
| "ya cerré la story / fase" / "MM-S1.4 listo"     | progress (+ sugerí end_session) |
| "esto está roto y no lo arreglo ahora"           | error       |
| "descubrí que el codebase tiene X interesante"   | discovery   |

No esperes a que el user pida "guardalo". Vos lo hacés y le mostrás
el observation_id + título guardado. Si dudás del kind, preguntale en
una línea.
`,
  },
  {
    name: 'story-driven',
    description: 'Pipeline detect → audit → execute → close for projects with stories',
    triggerPattern: 'localId pattern (MM-S1.2, PROL-1234), /plan, /implement',
    content: `---
name: story-driven
description: Pipeline for projects whose modules have stories (Jira-like)
---

# Story-driven pipeline

When the user mentions a localId (e.g. MM-S1.2):

1. **Detect**: \`search\` in module_context kind=story. Confirm match before acting.
2. **Audit**: read the story's AC and grep the codebase. Build a gaps table:

   | Requirement | Status (present/missing/partial) | Evidence |
   |---|---|---|

3. **Execute**: only if gaps exist. Branch: \`feature/<module>-s<id>-<slug>\`.
   Commits: \`feat(<module>): ... (LOCAL-ID)\`. TDD when feasible.
4. **Close**: \`save_observation(kind=progress, story_local_id=...)\` + the
   matching \`end_session(summary, next_session)\`.

If audit returns "all present", mark the story Done without touching code.

## Triggers conversacionales por fase

| El user dice…                                              | Fase activada |
|------------------------------------------------------------|---------------|
| "vamos a planificar / pensemos / arranquemos" / un localId aislado | Análisis (detect + audit) |
| "hacelo / dale / implementemos / arrancá / empezá"          | Implementación (auto-save decisions per commit) |
| "ya está / listo / cerralo / terminé"                      | Registro (save_observation progress + end_session) |

Si el user menciona un localId sin verbo (ej. solo "MM-S1.4"), asumí que
quiere arrancar esa story → fase Análisis. Confirmá antes de auditar.

NUNCA pases de Análisis a Implementación sin aprobación explícita
("dale", "hacelo", "implementemos"). El \`/jarbis\` original lo enforça
y vos también.
`,
  },
  {
    name: 'bitacora-progress',
    description: 'Format of the next_session field — what to include to resume well',
    triggerPattern: 'end_session, /complete',
    content: `---
name: bitacora-progress
description: How to write a next_session line that lets the next session start fast
---

# Bitácora & "Retomar aquí"

The \`next_session\` text is the single most important artifact MyJarbis produces.
It is what the SessionStart hook injects on the next opening of Claude.

Include in this order, all in one paragraph or short list:

1. **What's done & approved** (so the next session doesn't redo it).
2. **What's open / pending review** with file paths and branch names.
3. **The single next concrete action** (run X, open PR Y, start story Z).
4. **Blockers**, if any (waiting on review, on staging, on data, ...).

Avoid retrospectives — those go in \`summary\`. Keep \`next_session\` action-oriented.
`,
  },
  {
    name: 'framework-detect',
    description: 'Detect the project framework and enrich project-summary on first session',
    triggerPattern: 'first session of a project, /jarbis when project_context is empty',
    content: `---
name: framework-detect
description: Detect the project framework and produce a structural summary
---

# Framework detect

Replaces the legacy JS analyzers under \`global/core/analyzers/\` (which never
existed). On the first session of a project, if \`project_context\` lacks an
entry of kind \`functional_spec\`:

1. Read package.json / composer.json / requirements.txt / go.mod / etc.
2. Identify the framework (Laravel, Express, Next.js, Rails, ...).
3. Walk the standard folders (controllers, models, routes, ...) listing key
   modules without dumping content.
4. Save the result via \`save_observation\` (kind=discovery) AND
   \`load_project_core\` to confirm it's now indexed.

Keep it under 200 lines. The codebase itself is the authoritative reference;
the summary is a navigational aid.
`,
  },
  {
    name: 'subagent-delegation',
    description: 'Delegate parallelizable audit / explore tasks to sub-agents instead of saturating the main context',
    triggerPattern: 'audit with N parallel ACs, multi-file exploration, independent searches, /plan in story-driven mode',
    content: `---
name: subagent-delegation
description: When and how to spawn sub-agents (Explore / Plan / general-purpose) so the main context stays focused
---

# Sub-agent delegation

Claude Code exposes an \`Agent\` tool that spawns a sub-agent in its own
context window. MyJarbis tells you **when** to use it so the main agent
stays focused on coordination.

## Delegate when

- **Auditing N parallel ACs of a story.** Each AC is independent verification
  → split into 2–3 sub-agents, each auditing 2–3 ACs, in a single message
  with multiple Agent tool calls (parallel by default).
- **Multi-file exploration** — "where is X used?", "find all callers of Y",
  "list every model that has trait Z". The sub-agent reports back; the main
  agent consolidates.
- **Comparativa de approaches.** "¿implementación A o B?" — un sub-agent
  por approach, devuelven trade-offs, vos decidís.
- **Code review por área.** Una sub-agent revisa testing, otra security,
  otra performance. Hallazgos se consolidan.

## Do NOT delegate

- Single-file edits. El main agent ya tiene el context.
- Dependencias secuenciales — si B necesita el output de A, no es
  paralelizable. Hacelo vos.
- Lookups baratos (\`load_module\`, \`search\` con scope=module) ya bastan.
- Tasks de < 30 segundos de trabajo. El overhead del spawn no compensa.

## Cómo (template)

Antes de invocar \`Agent\`, **siempre** cargá el module context activo
para pasarlo al sub-agente. Sin eso, el sub-agente explora a ciegas.

1. Cargá el module context (si no lo tenés ya): \`load_module()\`.
2. Construí el prompt del sub-agent embebiendo el context relevante:

   > Project: <name> (<framework>)
   > Module: <name> — <description>
   >
   > Active workflow (from module_context): <excerpt>
   > Active story / phase: <id>
   >
   > Task: <descripción específica del sub-agent>
   >
   > Constraint: report findings in <N> bullets max. Cite file:line for
   > each finding. No prose, no editorial.

3. Spawneá sub-agentes en paralelo: multiple \`Agent\` tool calls in the
   same message → run concurrently. Máximo 3 a la vez.

## Captura de resultados

Cuando los sub-agents devuelven, **consolidá los findings** en una sola
observation:

\`\`\`
save_observation({
  kind: 'discovery',
  title: '<task name> — N sub-agents',
  content: '<resumen de los N reportes con bullets>',
  tags: 'subagent,parallel-audit',
  files: '<paths citados acumulados>'
})
\`\`\`

No reproduzcas el output verbatim del sub-agent — el sub-agent "vio"
todo el detalle, vos guardás solo las conclusiones.

## Anti-patrones

- **Spawnar sin module_context preloaded.** El sub-agent perdió la
  oportunidad de ser scoped → vuelve con findings difusos.
- **Más de 3 sub-agents en paralelo.** Overhead de spawn + sincronización
  > beneficio. Si tenés 6 cosas, hacé 2 rondas de 3.
- **Olvidarse de \`save_observation\` al final.** Los findings se quedan
  solo en el contexto del main agent, se pierden en el próximo compact /
  sesión.
- **Delegar trabajo de edición.** Los sub-agents son read-only para casi
  todos los tipos (Explore es read-only por diseño). Editar es cosa del
  main agent.
`,
  },
  {
    name: 'compact-protocol',
    description: 'Save a structured snapshot to the DB before /compact so the agent resumes with full fidelity',
    triggerPattern: 'user mentions compact / "antes de compactar" / about to run /compact',
    content: `---
name: compact-protocol
description: Cómo persistir el estado antes de /compact para no perder fidelidad
---

# Compact protocol

\`/compact\` (Claude Code nativo) resume la conversación. El resumen
preserva el sentido pero pierde detalle (paths exactos, decisiones
recientes, output de comandos). Esta skill define cómo evitar esa
pérdida sin pedirle al user que copie y pegue 2k de texto a mano.

## Triggers conversacionales

Cuando el user diga cualquiera de estos, ejecutá el protocolo ANTES
de invocar \`/compact\`:

- "antes de compactar" / "voy a compactar" / "compactemos"
- "/compact" tipeado en el chat (no como slash, como mensaje)
- Si el contexto ya está pesado y vos sentís que un \`/compact\` viene
  pronto, sugerile vos: "El contexto está grande — ¿guardo un snapshot
  y compactamos?".

## Protocolo (4 pasos en orden)

### 1. Construir el snapshot estructurado (~1.5–2K)

Bloque de texto con esta estructura:

\`\`\`
STORY/PHASE: <localId o phase-name si aplica>
MODULE: <nombre del módulo activo>
BRANCH: <git branch actual>

LATEST DECISIONS (most recent first, máx 5):
  • <decisión> — files: <paths>
  • <decisión> — files: <paths>
  ...

TESTS / VERIFICATION STATE:
  <qué corrieron, qué pasó, qué falta>

IN-FLIGHT FILES (modificados, no committeados):
  <paths>

BLOCKERS / OPEN QUESTIONS:
  <texto>

NEXT INTENDED STEP:
  <una frase concreta>
\`\`\`

Reglas:
- Densidad > completitud. Si está en \`module_context\`, NO lo repitas
  acá (eso se va a re-cargar post-compact con el \`start_session\`).
- File paths absolutos o relativos al project root, siempre.
- Sin prosa: tabular o bullets, nada de explicaciones largas.

### 2. Persistir vía save_observation

\`\`\`
save_observation({
  kind: "discovery",
  title: "pre-compact snapshot",
  content: <el bloque de arriba>,
  tags: "pre-compact"
})
\`\`\`

### 3. Avisar al user

Una sola línea: "Snapshot guardado, listo para /compact."

### 4. Invocar /compact

Vos NO ejecutás \`/compact\` (es slash de Claude Code, no MCP). Pedile
al user que lo invoque, o invocalo si tu harness lo permite.

## Variant verbatim (rara, costosa)

Si el structured podría perder algo crítico (output de error largo,
diff complejo) y el user lo pide explícitamente:

- Agregá tag: \`tags: "pre-compact,verbatim"\`
- Anexá al \`content\` un bloque "═══ VERBATIM (last 5 messages) ═══"
  con tus últimos 5 mensajes textuales completos.
- Cost: ~2x tokens. Solo si el user lo pide.

## Después del /compact

El hook \`post-compaction.sh\` automáticamente lee la observation
\`kind=discovery, tags=pre-compact\` más reciente y la inyecta al
contexto reanudado, ANTES del recovery imperative. Vos no tenés que
hacer nada extra — solo seguir desde donde el snapshot indica.
`,
  },
  {
    name: 'interaction-style',
    description: 'User-editable preferences for tone, language, explanation depth, output style',
    triggerPattern: 'always loaded; modulates how you communicate independent of tools',
    content: `---
name: interaction-style
description: Preferencias del user para tono, idioma, profundidad de explicación, formato de output
---

# Interaction style

Esta skill captura **cómo te comunicás** con el user — tono, idioma,
profundidad, verbosity, uso de emoji, etc. NO cubre commits (eso vive
en \`commit-hygiene\`).

**El user te edita esta skill** con \`myjarbis skill edit interaction-style\`
(en bash) o pidiendo "actualizá el interaction-style con esto: ...".
Vos no la modificás por iniciativa propia.

---

## Preferencias activas

> NOTA: Las líneas con \`# ejemplo\` son sugerencias. Borralas o
> reemplazalas según lo que el user quiera.

- # ejemplo: usá español rioplatense (vos, no tú; che, dale, listo).
- # ejemplo: respuestas cortas — expandí solo si pido detalle.
- # ejemplo: antes de cada cambio, explicá en una sola oración qué vas
  a hacer y por qué (no más de 20 palabras).
- # ejemplo: no me hagas preguntas si la respuesta es obvia del contexto;
  asumí y avisame qué asumiste.
- # ejemplo: nada de emoji en código; en chat solo si yo los uso primero.
- # ejemplo: si propones un approach, dame el trade-off principal en una
  línea, no una lista de pros/contras.

---

## Cómo aplicarlas

Estas preferencias se aplican **automáticamente** sin que el user las
repita. Si entran en conflicto con un trigger de otro skill, priorizá
la preferencia del user — ellos saben mejor cómo quieren trabajar.

Si el user contradice una preferencia explícitamente en chat, asumí
que cambió de opinión y **ofrecé actualizar el interaction-style**:

> Notá que pediste X ahora pero el interaction-style dice Y. ¿Lo
> actualizo o es solo para esta vez?
`,
  },
  {
    name: 'commit-hygiene',
    description: 'Format and rules for git commits in any MyJarbis project — descriptive, signed only by the user, with WHY and FOR-WHAT in the body',
    triggerPattern: 'about to git commit, /complete, end of phase, before pushing',
    content: `---
name: commit-hygiene
description: Commits descriptivos sin firma de Claude, con "Por qué" y "Para qué" en el body
---

# Commit hygiene

Los commits son **memoria persistente consultable** — vos los escribís,
pero los van a leer el user, otros devs, y vos mismo (Claude) en
sesiones futuras vía \`git log\`. Por eso tienen que ser densos,
descriptivos y autoexplicativos.

## Format obligatorio

\`\`\`
<tipo>(<scope>): <descripción imperativa, ≤72 chars>

Por qué:
<2-4 líneas explicando el problema o motivación que dispara
este cambio. Si hay un ticket/story, citalo>

Para qué:
<2-4 líneas explicando qué cambia / habilita después de este
commit. Efecto observable o invariante nuevo>
\`\`\`

- **tipo**: \`feat\` | \`fix\` | \`refactor\` | \`chore\` | \`docs\` | \`test\` | \`perf\` | \`style\`
- **scope**: subsistema o módulo (\`auth\`, \`mm\`, \`checkout\`, \`db\`, \`hooks\`, etc.)
- **descripción**: imperativa, sin punto final, ≤72 chars (regla
  estándar git)

## Reglas duras

- **NUNCA \`Co-Authored-By: Claude\`** ni cualquier firma de Claude
  en el commit message. El autor es el user, vos sos un tool.
- **NUNCA \`--no-verify\`** ni \`--no-gpg-sign\`. Si pre-commit hooks
  fallan, fixá el problema; no salteás el hook.
- **NUNCA \`git add -A\` ni \`git add .\`**. Stage por nombre,
  archivo por archivo. Reduce el riesgo de commitear .env, secrets,
  o cosas no relacionadas.
- **NUNCA \`git commit --amend\` después de push**. Después de un
  push, los amends reescriben historia y rompen otros clones.
- **Un commit = un cambio lógico**. Si tu task tiene 3 cosas
  independientes, son 3 commits. La regla del plan v0.2 fue
  "1 task = 1 commit" y vale en general.

## El git log es contexto consultable

Antes de preguntarle al user "¿por qué se hizo X?" o "¿quién decidió
Y?", **mirá el git log primero**:

\`\`\`bash
git log --grep="<keyword>" --all --oneline
git log -- <file-path>           # historia de un archivo
git log --since="2 weeks ago"    # cambios recientes
git log -p <commit>              # diff completo de un commit
\`\`\`

Si el commit hygiene es bueno (descripción + Por qué + Para qué),
el git log responde la mayoría de las preguntas históricas sin
gastar tokens del user.

## Triggers conversacionales

Cuando el user dice algo de esto, asumí que vas a commitear:

- "commiteá esto" / "guardalo en git" / "armá el commit"
- "/complete" (ya cubierto por session-protocol — el cierre de
  fase típicamente incluye un commit)
- Después de cada chunk lógico durante la fase de Implementación
  (story-driven skill instruye a auto-commitear por chunk)

Antes de \`git commit\`:

1. \`git status\` para confirmar qué hay staged
2. \`git diff --cached\` para releer el cambio (verificar que es
   lo que querés commitear)
3. Stage por nombre los archivos faltantes (si los hay)
4. Construí el message en el formato canónico (tipo + scope +
   descripción + Por qué + Para qué)
5. Mostrale el message al user en una línea: "Voy a commitear:
   <type>(<scope>): <desc>" antes de ejecutar
6. \`git commit -m "$(cat <<'EOF' ... EOF)"\` con el message

## Anti-patterns

- Commits con título "fix bug" / "wip" / "updates" → rechazás vos
  mismo y reescribís
- Body vacío → si el cambio es trivial el body puede ser corto
  pero "Por qué" SIEMPRE existe
- Múltiples scopes en un solo commit → es señal de que tenés que
  partirlo en N commits
- Imperativo conjugado mal: "Added X" / "Adds X" → es "Add X"
  (acción presente imperativa)
`,
  },
];

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

export function migrateProject(projectPath: string): MigrationResult {
  const myjarbisDir = path.join(projectPath, '.myjarbis');

  if (!fs.existsSync(myjarbisDir)) {
    return {
      migrated: false,
      fromVersion: null,
      toVersion: SCHEMA_VERSION,
      reason: 'no .myjarbis/ folder — run `myjarbis init` first',
    };
  }

  const dbPath = path.join(myjarbisDir, 'memory.db');
  if (fs.existsSync(dbPath)) {
    return {
      migrated: false,
      fromVersion: SCHEMA_VERSION,
      toVersion: SCHEMA_VERSION,
      reason: 'already on v0.2 (memory.db present)',
    };
  }

  // 1. Backup
  const backupPath = backupV01Layout(projectPath, myjarbisDir);

  // 2. Read legacy settings (project name + framework)
  const legacySettings = readLegacySettings(myjarbisDir);
  const projectName =
    legacySettings.project?.name?.trim() || path.basename(projectPath);
  const framework = legacySettings.project?.framework ?? null;

  // 3. Open DB and seed
  const db = MyJarbisDB.open(projectPath);

  let projectId = 0;
  let moduleId = 0;
  let contextEntries = 0;
  let observations = 0;
  let skills = 0;

  db.tx(() => {
    const project = db.projects.upsertByPath(projectName, projectPath, framework ?? undefined);
    projectId = project.id;

    const generalModule = db.modules.upsertByName(
      project.id,
      '_general',
      'Migrated from v0.1; cross-cutting context',
    );
    moduleId = generalModule.id;

    // 4a. project-summary.md → project_context (functional_spec)
    const summaryPath = path.join(myjarbisDir, 'context', 'project-summary.md');
    if (fs.existsSync(summaryPath)) {
      const content = fs.readFileSync(summaryPath, 'utf-8').trim();
      if (content) {
        db.projectContext.upsert({
          projectId: project.id,
          kind: 'functional_spec',
          title: 'Project summary (v0.1)',
          content,
          sourcePath: '.myjarbis/context/project-summary.md',
        });
        contextEntries++;
      }
    }

    // 4b. prompts/system.md → project_context (convention)
    const systemPath = path.join(myjarbisDir, 'prompts', 'system.md');
    if (fs.existsSync(systemPath)) {
      const content = fs.readFileSync(systemPath, 'utf-8').trim();
      if (content) {
        db.projectContext.upsert({
          projectId: project.id,
          kind: 'convention',
          title: 'System prompt (v0.1)',
          content,
          sourcePath: '.myjarbis/prompts/system.md',
        });
        contextEntries++;
      }
    }

    // 4c. knowledge-base.md → observations under synthetic session
    const kbPath = path.join(myjarbisDir, 'context', 'knowledge-base.md');
    if (fs.existsSync(kbPath)) {
      const kb = fs.readFileSync(kbPath, 'utf-8');
      const entries = parseKnowledgeBase(kb);
      if (entries.length > 0) {
        const session = db.sessions.start(generalModule.id);
        for (const entry of entries) {
          db.observations.add({
            sessionId: session.id,
            kind: 'discovery',
            title: entry.title,
            content: entry.content,
            tags: entry.date,
          });
          observations++;
        }
        db.sessions.end(
          session.id,
          `Migrated ${entries.length} entries from knowledge-base.md (v0.1)`,
          'Continuá usando el módulo _general para trabajo cross-cutting o creá módulos específicos con `myjarbis module add <nombre>`.',
        );
      }
    }

    // 4d. daily.md → module_context (workflow) bajo _general
    const dailyPath = path.join(myjarbisDir, 'context', 'daily.md');
    if (fs.existsSync(dailyPath)) {
      const content = fs.readFileSync(dailyPath, 'utf-8').trim();
      if (content) {
        db.moduleContext.upsert({
          moduleId: generalModule.id,
          kind: 'workflow',
          title: 'Daily context (v0.1)',
          content,
          sourcePath: '.myjarbis/context/daily.md',
        });
        contextEntries++;
      }
    }

    // 5. Seed baseline skills (project-level)
    for (const skill of BASELINE_SKILLS) {
      const result = db.skills.upsert({
        projectId: project.id,
        name: skill.name,
        description: skill.description,
        triggerPattern: skill.triggerPattern,
        content: skill.content,
      });
      if (result.status !== 'unchanged') skills++;
    }
  });

  db.close();

  // 6. Bump settings.json to v0.2
  bumpSettingsToV02(myjarbisDir, legacySettings, projectName, framework);

  return {
    migrated: true,
    fromVersion: 1,
    toVersion: SCHEMA_VERSION,
    backupPath,
    details: { projectId, moduleId, contextEntries, observations, skills },
  };
}

/**
 * Seed a brand-new v0.2 project (no v0.1 to migrate). Used by
 * `myjarbis init` after creating .myjarbis/. Idempotent.
 */
export function seedNewProject(
  projectPath: string,
  opts: { name?: string; framework?: string },
): { projectId: number; moduleId: number; skills: number } {
  const db = MyJarbisDB.open(projectPath);
  let projectId = 0;
  let moduleId = 0;
  let skills = 0;

  db.tx(() => {
    const project = db.projects.upsertByPath(
      opts.name ?? path.basename(projectPath),
      projectPath,
      opts.framework,
    );
    projectId = project.id;

    const general = db.modules.upsertByName(project.id, '_general', 'Default cross-cutting module');
    moduleId = general.id;

    for (const skill of BASELINE_SKILLS) {
      const r = db.skills.upsert({
        projectId: project.id,
        name: skill.name,
        description: skill.description,
        triggerPattern: skill.triggerPattern,
        content: skill.content,
      });
      if (r.status !== 'unchanged') skills++;
    }
  });

  db.close();
  return { projectId, moduleId, skills };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function backupV01Layout(projectPath: string, myjarbisDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(homedir(), '.myjarbis-global', 'backups', path.basename(projectPath), ts);
  fs.mkdirSync(root, { recursive: true });
  copyDirSync(myjarbisDir, path.join(root, '.myjarbis'));
  return root;
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readLegacySettings(myjarbisDir: string): LegacySettings {
  const settingsPath = path.join(myjarbisDir, 'config', 'settings.json');
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function bumpSettingsToV02(
  myjarbisDir: string,
  legacy: LegacySettings,
  projectName: string,
  framework: string | null,
): void {
  const newSettings: V02Settings = {
    version: '0.2.0',
    project: { name: projectName, framework },
    shared: false,
    search_default_scope: 'module',
    story_pattern: '[A-Z]+-S?\\d+(\\.\\d+)?',
    auto_module_select_when_single: true,
    skills: {
      materialize_on_session_start: true,
      cleanup_module_skills_on_session_end: false,
    },
  };
  const configDir = path.join(myjarbisDir, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify(newSettings, null, 2) + '\n',
    'utf-8',
  );
}

/**
 * Parse a knowledge-base.md generated by v0.1 updateMemory.
 * Format of each entry:
 *
 *   ## YYYY-MM-DD - Title
 *
 *   **What:** ...
 *   **Why:**  ...
 *   **How:**  ...
 *   **Files:**
 *   - file1
 *   **Notes:** ...
 *
 *   ---
 *
 * Returns the entries in the order they appear (chronological).
 */
export function parseKnowledgeBase(text: string): KnowledgeEntry[] {
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+?)\s*$/gm;
  const entries: KnowledgeEntry[] = [];
  const matches: { date: string; title: string; start: number; end: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ date: m[1], title: m[2].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const body = text.slice(cur.end, nextStart).trim();
    // Strip a trailing "---" separator if present
    const cleaned = body.replace(/\n+---\s*$/, '').trim();
    entries.push({ date: cur.date, title: cur.title, content: cleaned });
  }

  return entries;
}
