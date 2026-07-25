#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
URL="http://localhost:4173"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true; fi
python3 -m http.server 4173
