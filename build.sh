#!/bin/bash

set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

MODE=""
TARGET_DIR=""
APPS=()
ALL_APPS=("home" "admin" "user")
RELEASE=""

# ────────────── Parse arguments ──────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --mode)
            MODE="$2"
            shift 2
            ;;
        --target-dir)
            TARGET_DIR="$2"
            shift 2
            ;;
        --app)
            shift
            while [[ $# -gt 0 && ! $1 =~ ^-- ]]; do
                APPS+=("$1")
                shift
            done
            ;;
        --release)
            RELEASE="--release"
            shift
            ;;
        *)
            echo "❗ Unknown argument: $1"
            exit 1
            ;;
    esac
done

# ────────────── Validate ──────────────
if [ -z "$TARGET_DIR" ]; then
    echo "❗ Missing required argument: --target-dir PATH"
    exit 1
fi

if [ ${#APPS[@]} -eq 0 ]; then
    APPS=("${ALL_APPS[@]}")
fi

# ────────────── Clean target directories ──────────────
if [[ "$MODE" != "csr" && "$MODE" != "ssr" && -z "$MODE" ]]; then
    echo "🧹 Cleaning entire target directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

# ────────────── SSR build function ──────────────
build_ssr() {
    local app=$1
    local pkg="${app}-ssr"
    local outdir="${TARGET_DIR}/ssr/${app}"

    echo "🛠️  Building SSR for $app (package: $pkg)..."
    mkdir -p "$outdir"

    LEPTOS_OUTPUT_NAME="$pkg" \
    LEPTOS_SITE_ROOT="$outdir" \
    LEPTOS_SITE_PKG_DIR="." \
    cargo leptos build -p "$pkg" $RELEASE
}

# ────────────── CSR build function ──────────────
build_csr() {
    local app=$1
    local outdir="${TARGET_DIR}/csr/${app}"
    local public_url="/csr/${app}/"

    if [[ "$app" == "home" ]]; then
        public_url="/csr/"
    fi

    echo "🛠️  Building CSR for $app..."
    mkdir -p "$outdir"
    (cd "csr/$app" && trunk build $RELEASE --dist "$outdir" --public-url="$public_url")
}

# ────────────── Build apps ──────────────
for app in "${APPS[@]}"; do
    if [[ -n "$MODE" ]]; then
        echo "🧹 Cleaning $MODE/$app target directory..."
        rm -rf "${TARGET_DIR}/${MODE}/${app}"
    fi

    if [[ "$MODE" == "ssr" || -z "$MODE" ]]; then
        build_ssr "$app"
    fi

    if [[ "$MODE" == "csr" || -z "$MODE" ]]; then
        build_csr "$app"
    fi
done

echo "✅ All builds complete."
