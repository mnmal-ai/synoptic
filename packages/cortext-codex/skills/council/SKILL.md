---
name: council
description: "Pressure-test decisions using five independent AI advisors with distinct thinking styles. Use this skill when the user says 'council this', 'run the council', 'pressure-test this', 'should I X or Y', or any time they're facing a genuine decision with meaningful stakes — strategic pivots, architectural choices, pricing, feature priorities, hiring tradeoffs, or any fork-in-the-road moment. Do NOT use for factual lookups, simple creation tasks, or casual advice-seeking."
---

Load the full skill body from Substrate before proceeding:

1. **Query the coordinator namespace** — `cortext` by default, or whatever
   `SUBSTRATE_NAMESPACE` names. Substitute it; do not hardcode.

   ```json
   { "cortext/Skill": { "params": { "where": { "name": { "eq": "council" }, "active": { "eq": true } } }, "fields": { "body": true } } }
   ```

   Use the `query` MCP tool. The legacy `claude` namespace is **retired**
   and answers `unknown_namespace`.

2. **Check `errors` before reading `data`.** A `200` is not success here. A
   rejected frame comes back with **its key absent from `data`** and the reason
   in `errors`:

   ```
   HTTP 200
   data:   {}
   errors: [{ "message": "unknown namespace 'claude'", "code": "unknown_namespace",
              "path": ["claude/Skill"] }]
   ```

   So `data[key] ?? []` reads a rejected query as "no such skill". Assert the
   frame key you asked for came back; if it did not, report what `errors` says
   rather than that the skill is missing.

3. Follow the instructions in the returned `body` field exactly as if they were
   written here.

4. **Distinguish the three failures**, because they need different things said:
   - **frame rejected** (key absent, `errors` populated) — a namespace or field
     problem. Quote the server's message; it names the cause.
   - **frame answered, empty** (key present, `[]`) — no active `Skill` row by
     that name. The coordinator is fine; the row is missing or inactive.
   - **server unreachable** (connection error, non-2xx) — tell the user the
     skill requires a running Substrate instance.
