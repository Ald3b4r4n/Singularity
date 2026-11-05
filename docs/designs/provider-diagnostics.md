# Operational provider diagnostics

The normal OpenCode 2.2.5 profile reproducibly returns HTTP 503 on provider/model discovery. The official CLI repeats the same failure. The response identifies unfinished location plugin activation, not failed account authentication. The exact plugin/dependency remains undetermined: the public plugin API reports no registered server plugin in that failed location.

The Hub will expose fixed, structured diagnostics. It must never forward upstream error text, configuration, paths, credentials or prompts. Authentication configured, catalogue available, and model access are separate facts. HTTP 401/403 here refers to the local Hub/server connection; 429 is a rate limit; generic 503 is not automatically a plugin fault. Concurrent probes share their pending result, use a finite timeout and stop only their own temporary Job Object.

Assisted isolation must be explicit, per workspace, and temporary. Prefer a process-only official inline configuration overlay that filters plugins while leaving original configuration, policies, region and authentication in place. No credential copying or profile migration. Preserve existing sessions and label isolated sessions. Refuse unsafe overrides or unverified configuration/authentication. A new Hub returns to the normal profile for new sessions; surviving isolated sessions retain their identity.

Official references: https://opencode.ai/v2/docs/plugins/ ; https://opencode.ai/v2/docs/api ; https://docs.dev.opencode.ai/docs/config/ . Runtime behaviour must be checked against the installed version; documentation alone is not proof that an overlay was applied.

Risks: provider metadata can contain secrets, configured credentials can be stale, policy can override filtering, third-party plugins may supply required capabilities, and recovery must not silently move an existing session between profiles. Tests use controlled local fixtures and one small authorised OpenCode Go task only when needed. Team/application/correction scenarios already proven by real inference are regressed deterministically.
