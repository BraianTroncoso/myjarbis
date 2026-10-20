# /jarbis-save — Dejar la sesión escrita sin cerrarla

El usuario escribió esto porque hay algo que no conviene perder y el
trabajo no terminó. **El comando ES la confirmación** — no preguntes
"¿guardo?". Guardá y después mostrale en pocas líneas qué escribiste.

Esto es `/jarbis-close` menos `end_session`. La sesión queda abierta y se
sigue trabajando inmediatamente después.

---

## Por qué existe

`save_observation` ya pasa solo mientras trabajás — esa nunca fue la
falla. La falla es `set_project_state`, que hasta ahora solo ocurría al
cerrar. Entonces cualquier sesión que terminó sin `/jarbis-close` — un
cuelgue, una notebook que se cerró, un `/clear`, una sesión larga que se
fue por las ramas — dejó a la siguiente leyendo el estado de la sesión
anterior.

Esa falla es **invisible**. Nada parece roto: la sesión siguiente abre, el
banner imprime, el handoff está. Solo que describe un mundo que ya cambió.
Te enterás semanas después, cuando un agente retoma con total seguridad un
trabajo que ya estaba hecho.

Así que el punto de este comando no es pensar mejor qué guardar. Es que la
*secuencia de llamadas* esté garantizada en vez de recordada. Qué va en
cada nota sigue siendo tu criterio — eso funciona, y para eso nadie
necesita un comando.

---

## Orden (importa)

### 0. Primero mirá el estado real

Corré `git status --short`. Estás escribiendo lo que HAY, así que averiguá
qué hay. Si el proyecto tiene tests y los corriste, anotá el resultado; si
no los corriste, decilo en vez de darlo por hecho.

A diferencia de `/jarbis-close`, **tener trabajo sin commitear no es razón
para frenar.** Acá es el caso normal: un checkpoint ocurre en medio del
trabajo. Registralo como parte del cuadro.

### 1. Todo lo de esta sesión que todavía no se guardó

Por cada decisión, gotcha, error o avance desde el último guardado:
`save_observation` con el `kind` correcto, `content` ordenado POR QUÉ →
QUÉ → CÓMO, y `files`.

Para cualquier cosa que tenga un **valor actual** en vez de una historia,
llamá primero a `suggest_topic_key` y reusá la clave que devuelve — eso
actualiza la nota en lugar de dejarle una rival al lado.

No guardes una nota por archivo tocado. Guardá lo que le ahorraría una hora
a quien abra esto en tres semanas.

### 2. Historias tocadas → `update_progress`

Por cada historia trabajada desde el último guardado:
`update_progress(local_id, progress)` con estado (`✅ done` / `🔄 wip` /
`🔴 blocked`), commits, fecha y notas de smoke. Esto es estado relacional
de la fila, no una lección de sesión — no uses `save_observation` para eso.

Salteá este paso en un módulo sin historias. No inventes una.

### 3. `set_project_state` — el paso por el que existe este comando

**Nunca lo saltees.** Si vas a hacer una sola cosa acá, hacé esta.

**Reemplaza** su contenido anterior: escribí el cuadro completo, no un
delta. En este orden:

- dónde está el trabajo ahora mismo;
- qué está **verificado** y qué no (el número de la suite si la corriste,
  "no corrida" si no);
- la próxima acción concreta;
- lo que ya está medido y resuelto, para que no se vuelva a discutir.

Escribilo como si la sesión terminara acá — porque puede terminar. Esa
suposición es lo que hace que valga la pena tipear el comando.

### 4. Recap, en cuatro líneas o menos

Los títulos que guardaste, una línea sobre qué dice ahora
`set_project_state`, y el ofrecimiento de reescribir cualquiera de los dos.
Después dejá de hablar y volvé al trabajo.

---

## Usarlo antes de `/compact`

Este es el protocolo de pre-compactación. Corré `/jarbis-save` primero y
después `/compact`. Todo lo de arriba sigue valiendo, más esto:

- En el paso 1, agregá un `save_observation` con `kind: "discovery"` y
  `tags: "pre-compact"` con el snapshot estructurado: el hilo abierto, las
  decisiones ya tomadas en esta sesión, las rutas en juego, y todo lo que
  tengas en la cabeza y no esté escrito en ningún lado.
- Pecá de largo. Después de la compactación, esa nota y `project_state` es
  todo lo que sobrevive del razonamiento.

---

## Reglas

- **No llames a `end_session`.** Eso es `/jarbis-close`. Si el usuario en
  realidad quiere parar, decilo y mandalo para allá.
- **No commitees ni pushees.** Guardar es un acto de memoria, no de git.
- **No inventes avance.** Si pasó poco desde el último guardado, el estado
  dice que pasó poco. Un checkpoint optimista es peor que ninguno, porque
  la sesión siguiente se lo cree.
- **No re-guardes lo ya guardado.** Fijate qué escribió ya esta sesión
  antes de agregar una segunda nota sobre lo mismo; usá
  `update_observation` para corregir una en el lugar en vez de apilarle la
  corrección al lado.
- **Si no hay sesión abierta**, decilo e igual escribí `set_project_state`
  — es la parte que sobrevive de cualquier manera.
- El lenguaje natural sigue funcionando. "Guardá esto", "actualizate la
  memoria", "anotá esto antes de que se pierda" significan lo mismo. El
  comando solo garantiza el piso.
