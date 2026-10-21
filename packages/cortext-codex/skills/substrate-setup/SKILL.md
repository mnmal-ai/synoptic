---
name: substrate-setup
description: Configure this local Cortext Codex plugin with a Substrate endpoint and a distinct Codex signing identity, or diagnose its hooks and MCP wiring.
---

Use [the plugin installation guide](../../README.md) for the settings shape and local
installation procedure. Inspect the existing setup first; merge settings instead
of replacing unrelated configuration.

Use the operator's chosen Substrate URL and already installed Substrate MCP executable.
If either is missing, ask for it. There is no default endpoint or automatic
download. Use a distinct Codex identity, never the Claude or OpenCode kid/key.
For a new identity, use Synoptic's `provisionIdentity` plan with agent `codex`,
the repo basename, host, and the `cortext` and `recall` namespaces. Review the
generated registration steps before applying them to the operator's runtime;
do not edit a live key registry merely to diagnose setup.

Write machine-specific values to the gitignored `<repo>/.codex/cortext.local.json`.
Both hook and MCP processes read this file; MCP `[env]` settings alone do not
configure hooks. Keep private keys outside the repo and use absolute key and
executable paths. Never read or print private key contents.

Use the local marketplace and enable the plugin for this trusted repo. Keep
exactly one Substrate MCP connection for this identity; remove a redundant standalone
connection only as part of the user's requested setup. Restart Codex and use
`/hooks` to review and trust the three bundled hook definitions. Do not bypass
hook trust for ordinary installation. Until hooks are trusted, cold-start is
not automatic: use Substrate tools to load context explicitly.

Verify the MCP schema, effective identity, and namespaces with the connected
tools. Check `errors` and the requested frame's presence in `data`; HTTP 200
alone does not prove success. Verify startup context and prompt inbox delivery.
Only send a test peer message when the user authorizes that messaging test.
Report installation, hook trust, and live Substrate verification separately.
