# MyJarbis — orquestador per-proyecto para Claude Code

> **Memoria persistente, workflow propio del proyecto, y skills
> scoped — un solo slash command, lo demás conversacional.**

MyJarbis convierte Claude Code en un orquestador project-aware: se
acuerda de lo que decidiste, dónde quedaste, y qué workflow aplica
en cada vertical del proyecto — sin tirarte todo el contexto en la
cara cada sesión.

```
cd ~/dev/<proyecto>
claude
> /jarbis
```

Eso es todo. Después hablás natural.

---

## Por qué existe

Claude Code solo no tiene memoria de proyecto. Repetís convenciones,
re-explicás arquitectura, perdés "qué estaba haciendo ayer".
Herramientas de memoria existentes resuelven la persistencia pero
tratan la memoria como un bag plano.

En proyectos reales, el trabajo es **vertical**. No trabajás en "el
codebase"; trabajás en el Media Manager, después en Page Builder,
después en Translations. Cada vertical tiene su workflow, plan,
stories y skills.

MyJarbis modela eso explícitamente:

```
proyecto
  ├── project_context (practices, deps, conventions, specs — siempre cargado)
  ├── modules (verticales — vos los creás)
  │     ├── module_context (workflow, plan, stories, AC del vertical)
  │     ├── sessions (lifecycle: start → save observations → end)
  │     │     └── observations (decisions, gotchas, progress)
  │     └── skills (module-level — solo cuando ese módulo está activo)
  └── skills (project-level — siempre cargadas, las 10 baselines)
```

Cuando abrís Claude en un proyecto MyJarbis, el SessionStart hook te
pregunta qué vertical querés tocar. **Solo se carga ese módulo +
project core.** Otros módulos no entran al contexto.

---

## Install

```bash
git clone https://github.com/braiantroncoso/myjarbis.git
cd myjarbis
./install.sh
```

Esto instala en `~/.myjarbis-global/`, buildea el MCP server (Node +
better-sqlite3 + FTS5), agrega `myjarbis` al PATH y configura el MCP
de Claude Code.

Verificá: `myjarbis doctor` debería imprimir 25+ checks verdes.

---

## Bootstrap de un proyecto

```bash
cd ~/proyectos/mi-app
myjarbis init                          # crea memory.db + 10 baselines + plugin hooks
myjarbis module add backend
myjarbis module add frontend
```

Ahora importá los .md que ya tenés (los que llenás a mano hoy):

```bash
# Project-level
myjarbis import agents/WORKFLOW.md   --target=project       --kind=workflow
myjarbis import agents/PRACTICES.md  --target=project       --kind=practice

# Module-level
myjarbis import agents/backend/WORKFLOW.md --target=module:backend --kind=workflow
myjarbis import agents/backend/PLAN.md     --target=module:backend --kind=plan

# Bulk JSON (Jira, Linear, etc.)
myjarbis import agents/backend/Jira.json \
  --target=module:backend --kind=story --mapping='stories[]'
```

Re-imports son **idempotentes** (hash SHA-256 sobre el content): si no
cambió, no-op; si cambió, UPDATE en su lugar.

Ajustá tus preferencias:

```bash
myjarbis skill edit interaction-style    # tono, idioma, profundidad
myjarbis skill edit commit-hygiene       # opcional — default ya viene útil
```

---

## Daily flow

```bash
cd ~/proyectos/mi-app
claude
> /jarbis
```

El SessionStart hook se dispara y verás algo así:

```
═══ MyJarbis · mi-app (laravel) ═══
Modules:
  • backend, last session 2h ago
  • frontend (paused)

Pick a module to begin (e.g., "let's work on backend").

── Last "Retomar aquí" (backend, 2h ago) ──
PR #1234 mergeado a develop. Próxima sesión: arrancar AUTH-12
con el JWT refresh flow. Branch: feature/auth-12-refresh-jwt.
```

Decís *"vamos backend"* → el agente llama `start_session("backend")`.
Tiene project_core + backend context + el `next_session` de la sesión
anterior. Las skills se materializan a `.claude/skills/myjarbis-*/` —
**solo las 10 baselines + las module-level de backend**. Las de
frontend no están en disco.

A partir de acá, **todo es lenguaje natural**. El agente sabe qué
tools MCP llamar gracias al prompt de `/jarbis` + las 10 skills:

| Vos decís…                                     | El agente hace                                   |
|-------------------------------------------------|--------------------------------------------------|
| "trabajemos AUTH-12"                            | search story + audit AC + propone phase          |
| "vamos a planificar el refresh flow"            | fase Análisis (no toca código todavía)           |
| "dale, hacelo"                                  | fase Implementación + auto-save de decisions     |
| "decidí usar Laravel Sanctum"                   | save_observation(kind=decision)                  |
| "ojo, refresh tokens necesitan revocar el access" | save_observation(kind=gotcha)                  |
| "commiteá esto"                                 | git commit con format Por qué/Para qué + sin firma |
| "vamos a tocar frontend"                        | confirma + end_session + start_session(frontend) |
| "donde estaba?"                                 | resume() → te lee el "Retomar aquí"              |
| "antes de compactar"                            | save_observation(pre-compact) → vos /compact     |
| "listo, cerralo"                                | confirma summary + next_session + end_session    |

El próximo `/jarbis` resume desde donde quedaste.

---

## El único slash command

```
/jarbis
```

Y nada más. **No existen** `/plan`, `/implement`, `/complete`,
`/module`, `/skill`, `/resume`, `/import`, `/compact`. Todo eso lo
infiere el agente del lenguaje natural gracias a las 10 skills
baseline que se cargan automáticamente al iniciar.

---

## Las 10 skills baseline

Cualquier `myjarbis init` arranca con estas. Se materializan a
`.claude/skills/myjarbis-<name>/SKILL.md` y Claude las carga al
iniciar.

| Skill                  | Qué le enseña al agente                                       |
|------------------------|---------------------------------------------------------------|
| `module-orchestration` | Cómo elegir/cambiar módulo + triggers de switch               |
| `session-protocol`     | Cuándo cerrar sesión + format de summary + next_session       |
| `observation-protocol` | Cuándo guardar decision/gotcha/progress + triggers naturales  |
| `story-driven`         | Pipeline detect → audit → execute → close por fases           |
| `bitacora-progress`    | Cómo escribir el "Retomar aquí" para que sirva mañana         |
| `framework-detect`     | Auto-explorar el codebase la primera vez                      |
| `subagent-delegation`  | Cuándo lanzar Explore/Plan/general-purpose en paralelo        |
| `compact-protocol`     | Snapshot estructurado antes de `/compact` nativo              |
| `interaction-style`    | Tu tono / idioma / profundidad / verbosity (lo editás vos)    |
| `commit-hygiene`       | Format de commits + git log es contexto consultable           |

Las 2 más interesantes:

**`commit-hygiene`** — cualquier commit en cualquier proyecto:
```
<tipo>(<scope>): <descripción imperativa>

Por qué:
<2-4 líneas: motivación / problema>

Para qué:
<2-4 líneas: qué cambia / habilita>
```
Sin `Co-Authored-By: Claude`, sin `--no-verify`, sin `git add -A`.
**Insight:** el git log queda como memoria consultable — antes de
preguntar "¿por qué se hizo X?", el agente mira `git log --grep` o
`git log -- <path>`.

**`interaction-style`** — placeholder editable con tus preferencias.
Ejemplos típicos:
- "usá español rioplatense"
- "antes de cada cambio explicame en una oración"
- "respuestas cortas, expandí solo si pido"
- "no me hagas preguntas si la respuesta es obvia"

Lo editás una vez con `myjarbis skill edit interaction-style` y se
respeta automáticamente en cada sesión sin repetirlo.

---

## Skills custom (cuando un proyecto necesita algo propio)

Un proyecto puede agregar sus propias skills (project-level o
module-level):

```bash
# project-level (siempre activa en este proyecto)
myjarbis skill add jira-rules --content-from=docs/jira-rules.md \
  --description="Reglas de tracking JIRA para este proyecto"

# module-level (solo activa cuando estás en MM)
myjarbis skill add mm-pixel-perfect --module=MM \
  --content-from=docs/mm-pixel-perfect.md \
  --description="MM: copiar HTML del design package, NUNCA reinterpretes"
```

Cuando hacés `start_session(MM)`, las module-level del MM se
materializan a `.claude/skills/`. Cuando cambiás de módulo, esas
desaparecen del filesystem y aparecen las del nuevo.

---

## Lo que pasa por atrás (hooks)

`.claude-plugin/hooks/hooks.json` registra 4 eventos. No los invocás
vos — Claude Code los dispara solo:

- **SessionStart (startup|clear)** → menú de módulos + auto-start si
  hay 1 solo + materializa skills + surface "Retomar aquí"
- **SessionStart (compact)** → trae el pre-compact snapshot al
  contexto reanudado + recovery imperative
- **UserPromptSubmit** → primer mensaje fuerza ToolSearch para los
  tools de MyJarbis + detecta regex de localId (story_pattern) +
  reminder cada 15 min sin save_observation
- **Stop** → si hay sesión abierta, te recuerda cerrarla

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE CODE (harness)                                          │
│  • hooks  • /jarbis (único)  • skills cargadas desde .claude/   │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP SERVER (Node/TS, ~/.myjarbis-global/mcp-server/)           │
│  Discovery:  current_project, list_modules, create_module       │
│  Session:    start_session, end_session, resume                 │
│  Read/Write: load_project_core, load_module, search,            │
│              save_observation                                   │
│  Skills:     list_skills, add_skill, materialize_skills         │
│  Bootstrap:  import_md, import_json                             │
│  Legacy:     search_code, get_context, update_memory            │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite (.myjarbis/memory.db) — better-sqlite3 + FTS5           │
│  projects → project_context · modules · skills                  │
│  modules → module_context · sessions → observations             │
└─────────────────────────────────────────────────────────────────┘
```

Cada proyecto tiene su propio `memory.db`. Decisís per-proyecto si
es:
- `shared: true` → committeado al repo, todo el equipo carga el
  mismo contexto + skills
- `shared: false` (default) → en `.gitignore`, contexto y skills
  personales

---

## Search scoped

`search` es FTS5 sobre project_context, module_context, skills y
observations. Scopes:

- `module` (default): módulo activo + project_core. **Token-saving.**
- `project`: todos los módulos del proyecto + project_core
- `module_only`: solo el módulo activo/nombrado
- `observations`: solo el log de la sesión
- `skills`: solo content de skills

El scope default `module` es la diferencia clave: con 5 módulos
indexados, el agente solo ve hits del módulo activo, no de los
otros 4.

---

## Migrar desde v0.1

Si venías de v0.1 (sin memory.db, todo en `.myjarbis/context/*.md`),
abrir Claude en el proyecto migra automáticamente:

- `knowledge-base.md` → observations bajo módulo `_general`
- `daily.md` → module_context (workflow)
- `project-summary.md` → project_context (functional_spec)
- `prompts/system.md` → project_context (convention)
- 10 baselines sembradas

Backup automático a `~/.myjarbis-global/backups/<project>/<ts>/`.
Aliases legacy (`search_code`, `get_context`, `update_memory`)
siguen funcionando.

---

## CLI bash (setup / admin, fuera de Claude)

```bash
myjarbis init                       # init project
myjarbis doctor                     # health check (25+ probes)
myjarbis stats                      # contadores por tabla
myjarbis list                       # proyectos registrados
myjarbis update                     # pull + rebuild MCP

myjarbis module add <name> [--description=...]
myjarbis module list

myjarbis skill add <name> --content-from=<file> [--module=...] [--description=...] [--trigger=...]
myjarbis skill list [--scope=all|project|module|session]
myjarbis skill edit <name> [--module=...]
myjarbis skill delete <name> [--module=...]
myjarbis skill enable|disable <name> [--module=...]
myjarbis skill materialize [--module=...]

myjarbis import <file.md>   --target=<project|module:NAME> --kind=<kind>
myjarbis import <file.json> --target=... --kind=<kind> --mapping='items[]'
                                                       [--id-field=...] [--title-field=...]
```

---

## Settings per-proyecto

`.myjarbis/config/settings.json`:

```json
{
  "version": "0.2.0",
  "project": { "name": "mi-app", "framework": "laravel" },
  "shared": false,
  "search_default_scope": "module",
  "story_pattern": "[A-Z]+-S?\\d+(\\.\\d+)?",
  "auto_module_select_when_single": true,
  "skills": {
    "materialize_on_session_start": true,
    "cleanup_module_skills_on_session_end": false
  }
}
```

---

## Tests

```bash
tests/bootstrap-prolicht.sh    # 12 .md + 1 JSON bulk import idempotency
tests/skills-lifecycle.sh      # baselines + module-level + cleanup on switch
tests/full-session-cycle.sh    # abrir → trabajar → cerrar → reabrir
tests/compact-cycle.sh         # snapshot pre/post /compact roundtrip
```

---

## License

MIT.

— Built by Braian Axel Troncoso 🇦🇷.
