---
name: dotnet-backend-guidance
description: "Searches local C#/.NET backend best practices before implementing ASP.NET Core APIs, service logic or EF Core data access. Use for backend patterns, configuration, security and performance, not frontend or infrastructure tasks."
---

# dotnet-backend-guidance — local use

Use the locally installed `dotnet-backend-guidance` command, not `npx` or an npm registry download. Search before implementing .NET backend changes.

1. Search one capability at a time with a short English query:

   ```sh
   dotnet-backend-guidance search "retry flaky http calls"
   ```

2. Choose guides by their returned descriptions, then get them by ID:

   ```sh
   dotnet-backend-guidance get resilient-http-calls
   ```

   Multiple IDs can be comma-separated. If output was saved to a temporary file, read that file in full with your file-reading tool.

3. Apply the relevant rules and check **Version notes** against the target project's framework and package versions. Keep the project's existing conventions. Mention the guide IDs that informed the change.

If results are unrelated or empty, rephrase once, then use `dotnet-backend-guidance list`. If no guide fits, continue without claiming guidance was found.

## Local command setup

The user sets up the guidance checkout once with `pnpm install`, `pnpm build`, then `npm link` from its repository root. The linked command works from other projects; rebuilding updates it without linking again. On Windows, use `dotnet-backend-guidance.cmd` if PowerShell blocks the `.ps1` shim.

If the command isn't on PATH, use `node "<absolute-path-to-guidance-checkout>/dist/cli.mjs" search "<query>"` (and the same prefix for `get` or `list`). Resolve the checkout path from the user's setup; ask if it isn't known. Don't assume the application repository is the guidance checkout.

If the index is missing or needs an update, run `pnpm build` in the guidance checkout, not the application repository. Search itself requires no network or API keys.
