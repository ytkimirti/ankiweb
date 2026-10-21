#!/bin/bash
# Copies the assets desktop's media server provides under /_anki into
# web/static/_anki: MathJax (with Anki's config) and the shared images.
# Only writes inside web/static/_anki; safe to rerun.
set -euo pipefail
cd "$(dirname "$0")/../.."
dest=web/static/_anki
mkdir -p "$dest/js/vendor/mathjax" "$dest/imgs"
cp -R node_modules/mathjax/es5/. "$dest/js/vendor/mathjax/"
node_modules/.bin/esbuild ts/mathjax/index.ts --outfile="$dest/js/mathjax.js" --minify --target=es2020 --log-level=warning
cp -R qt/aqt/data/web/imgs/. "$dest/imgs/"
echo "vendored assets into $dest"
