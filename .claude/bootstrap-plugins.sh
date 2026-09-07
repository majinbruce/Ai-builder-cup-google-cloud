#!/usr/bin/env bash
# Install the Claude Code plugins this boilerplate expects.
#
# Run once per machine after cloning. `.claude/settings.json` registers the
# marketplace and enables these plugins, but Claude Code does not auto-install
# plugins from external sources -- it only reports them as missing. This script
# closes that gap.
set -euo pipefail

MARKETPLACE="claude-plugins-official"

PLUGINS=(
  typescript-lsp        # LSP diagnostics + navigation for the API and web/
  security-guidance     # injection / secrets / SSRF / XSS review on edits
  modern-web-guidance   # current web + Next.js practices, not training-data ones
  mattpocock-skills     # TypeScript engineering: TDD, type design, domain modelling
  playwright            # browser automation and E2E for web/
  frontend-design       # non-generic UI work in web/
)

command -v claude >/dev/null 2>&1 || {
  echo "claude CLI not found on PATH; install Claude Code first." >&2
  exit 1
}

# typescript-lsp is inert without this binary -- it surfaces as
# "Executable not found in $PATH" in the /plugin Errors tab.
if ! command -v typescript-language-server >/dev/null 2>&1; then
  echo "==> installing typescript-language-server (required by typescript-lsp)"
  npm install -g typescript-language-server typescript
fi

echo "==> registering marketplace $MARKETPLACE"
claude plugin marketplace add anthropics/claude-plugins-official 2>/dev/null || true

for p in "${PLUGINS[@]}"; do
  echo "==> $p"
  claude plugin install "$p@$MARKETPLACE" --scope user --yes
done

echo
echo "Done. Run /reload-plugins in an open session, or just start a new one."
