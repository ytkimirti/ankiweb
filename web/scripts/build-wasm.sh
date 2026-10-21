#!/bin/bash
# Builds web/wasm for wasm32-wasip1 and optimizes it into web/static/engine.
# Needs wasi-sdk (WASI_SDK) for the bundled C code (SQLite, zstd), and wasm-opt.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${WASI_SDK:?set WASI_SDK to a wasi-sdk install}"
export CC_wasm32_wasip1="$WASI_SDK/bin/clang"
export AR_wasm32_wasip1="$WASI_SDK/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK/share/wasi-sysroot"
profile=${PROFILE:-release-web}
cargo build -p anki_web --target wasm32-wasip1 --profile "$profile"
target_dir=${CARGO_TARGET_DIR:-target}
mkdir -p web/static/engine
wasm-opt -Oz --strip-debug --strip-producers \
    --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    "$target_dir/wasm32-wasip1/$profile/anki_web.wasm" -o web/static/engine/anki.wasm
ls -la web/static/engine/anki.wasm
