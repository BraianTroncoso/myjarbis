# /myjarbis compact — Compact con snapshot pre/post

Tu workflow manual era: llamar `/compact`, copiar ~2k del CLI, pegar
con prefijo "Acabo de compactar...". Esto lo automatiza con una
fidelidad mejor: vos no copiás texto crudo (mucho ruido); el agente
dumpa un **snapshot estructurado** que el hook post-compaction
re-inyecta automáticamente.

## Forms

### `/myjarbis compact`  — modo default (structured snapshot)

Pasos que el agente debe ejecutar **en este orden**:

1. **Construir el snapshot.** Producir un bloque de texto de
   ~1.5–2K caracteres con el estado actual de la sesión:

   ```
   STORY/PHASE: <story-id o phase-name si aplica>
   MODULE: <nombre del módulo activo>
   BRANCH: <git branch actual si la sabés>

   LATEST DECISIONS (most recent first):
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
   ```

   Reglas:
   - Densidad > completitud. Si dudás entre incluir o no algo,
     incluilo solo si NO está ya en `module_context` (que se va a
     re-cargar post-compact por el `start_session`).
   - File paths SIEMPRE absolutos o relativos al project root.
   - Sin prosa: tabular o bullets, nada de explicaciones largas.

2. **Persistir el snapshot.** Llamar:
   ```
   save_observation({
     kind: "discovery",
     title: "pre-compact snapshot",
     content: <el bloque de arriba>,
     tags: "pre-compact"
   })
   ```

3. **Avisar al user** en una línea: "Snapshot guardado, ejecutando /compact...".

4. **Invocar /compact** (Claude Code nativo).

Después del `/compact`, el hook `post-compaction.sh` automáticamente
imprime:
```
═══ Pre-compact snapshot (<timestamp>) ═══
<content>

═══ MyJarbis · post-compaction recovery ═══
1. Call current_project ...
```

El agente reanudado lee el snapshot + el recovery y arranca con
fidelidad alta.

### `/myjarbis compact --verbatim`  — structured + texto crudo

Para tasks donde el structured podría subestimar algo (p.ej., un
output de error largo, un diff complejo), el `--verbatim`
agrega los **últimos 5 mensajes textuales del agente** al final
del snapshot.

Pasos: igual que el modo default, pero en el paso 1 además de
producir el structured, anexar al `content` un bloque:

```
═══ VERBATIM (last 5 assistant messages) ═══

<MSG -5> ...
<MSG -4> ...
<MSG -3> ...
<MSG -2> ...
<MSG -1> ...
```

Y en el paso 2 cambiar `tags` a `"pre-compact,verbatim"` (el hook
detecta el tag y lo señala en el header del bloque post-compact).

Cost: ~2x tokens en el snapshot. Solo si lo necesitás.

## Cuando NO usarlo

- Si la sesión es muy corta (< 5 min de trabajo): `/compact` solo
  basta, no hay nada importante que el resumen pierda.
- Si recién hiciste `/complete`: el `next_session` ya capturó el
  estado canónico; el snapshot duplica.

## Después del compact

El hook ya inyectó el snapshot. Lo siguiente que hace el agente
reanudado:
1. Re-`current_project` + `list_modules` + `start_session(<active>)`.
2. Releer el snapshot del bloque inyectado.
3. Continuar con el siguiente mensaje del user.

El snapshot vive en la DB como una observation regular — queda en
el log para auditoría. No se borra automáticamente; si te molesta el
ruido, `myjarbis search "pre-compact" --scope=observations` te lista
los snapshots históricos.
