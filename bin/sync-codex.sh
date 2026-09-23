#!/bin/bash
set -euo pipefail
mkdir -p "$HOME/.codex/prompts"
cp -av ./.codex/prompts/*.md "$HOME/.codex/prompts/"
echo "Synced repo prompts to ~/.codex/prompts/"