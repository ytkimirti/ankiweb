#!/bin/bash
# Generates the TypeScript protobuf, backend and translation modules that ts/
# and web/ import from out/ts/lib/generated. Needs protoc (PROTOC) and
# node_modules at the repo root.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=out/ts/lib/generated
mkdir -p "$out"
# build scripts of these crates write backend.ts, backend-methods.ts and ftl.ts
cargo build -p anki_proto -p anki_i18n
"${PROTOC:-protoc}" -I proto proto/anki/*.proto \
    --plugin node_modules/.bin/protoc-gen-es --es_out "$out"
node_modules/.bin/tsx ts/tools/markpure.ts "$out"
cp ts/lib/generated/*.ts "$out"/
echo "generated $(find "$out" -name '*.ts' -o -name '*.js' | wc -l) files in $out"
