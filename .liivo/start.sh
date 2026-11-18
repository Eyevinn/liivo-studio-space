#!/bin/bash
# Throwaway preview-gate test: serves a static page on the port the orchestrator routes to.
mkdir -p /tmp/site && cd /tmp/site
echo "<h1>liivo-studio-space preview test</h1><p>host: $(hostname) port: ${PORT:-unset}</p>" > index.html
echo "asset ok" > asset.txt
exec python3 -m http.server "${PORT:-8080}" --bind 0.0.0.0
