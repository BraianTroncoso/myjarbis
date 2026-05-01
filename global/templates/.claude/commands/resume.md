# /resume — Show "Retomar aquí" without changing state

Read-only. Surfaces the most recent `next_session` of the active
module (or a named one) so the user remembers where things were
left.

## Forms

### `/resume`  — active module

If a session is active, call `resume({ module: <activeModuleName> })`.
If not, fall back to listing modules and showing each one's last
`next_session` so the user can pick.

### `/resume <module>`  — a specific module

Call `resume({ module: "<name>" })` and print:

```
Module: <name>
Last session ended: <relativeTime>
Summary:
  <summary>
Retomar aquí:
  <next_session>
```

If `hasNextSession: false`: tell the user no closed session yet
in that module.

## Notes

- `/resume` does NOT call `start_session`. It's purely diagnostic.
- It's the same data the SessionStart hook injects automatically;
  use this command if you need to re-read it mid-session.
