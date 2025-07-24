#!/bin/bash

set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET_DIR=""
APPS=()
ALL_APPS=("home" "admin" "user")
RELEASE=""
MODE="both" # default: both

# ────────────── Parse arguments ──────────────
while [[ $# -gt 0 ]]; do
    case $1 in
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
        --mode)
            MODE="$2"
            shift 2
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

# ────────────── Convert to absolute path ──────────────
if [[ "$TARGET_DIR" = /* ]]; then
    : # Already absolute
elif [[ "$TARGET_DIR" = ~* ]]; then
    # Expand ~ to $HOME
    TARGET_DIR="${TARGET_DIR/#\~/$HOME}"
    echo "📌 Expanded ~ to absolute path: $TARGET_DIR"
else
    TARGET_DIR="$(pwd)/$TARGET_DIR"
    echo "📌 Converted relative to absolute: $TARGET_DIR"
fi

# ────────────── If no specific apps are provided, default to all ──────────────
if [ ${#APPS[@]} -eq 0 ]; then
    APPS=("${ALL_APPS[@]}")
fi

# ────────────── Clean full target directory (on explicit request) ──────────────
if [ "$MODE" == "both" ] && [ ${#APPS[@]} -eq ${#ALL_APPS[@]} ]; then
    echo "🧹 Cleaning entire target directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

# ────────── Ensure target directory exists if not present ──────────
if [ ! -d "$TARGET_DIR" ]; then
    echo "📁 Target directory $TARGET_DIR does not exist. Creating..."
    mkdir -p "$TARGET_DIR"
fi

# ────────────── Run build.rs (via cargo check) ──────────────
echo "🧪 Running build.rs via cargo check..."
cargo check -p shared

# ────────────── Copy frontary-leptos static assets from OUT_DIR ──────────────
echo "📤 Copying frontary-leptos static files from OUT_DIR..."

OUT_DIR=$(cargo build -p shared --message-format=json \
  | grep '"reason":"build-script-executed"' \
  | sed -n 's/.*"out_dir":"\([^"]*\)".*/\1/p' \
  | tail -n1)

if [ -z "$OUT_DIR" ]; then
    echo "❗ Failed to determine OUT_DIR from cargo build output."
    exit 1
fi

if [ ! -d "$OUT_DIR/frontary-leptos-static" ]; then
    echo "❗ frontary-leptos-static not found in OUT_DIR: $OUT_DIR"
    exit 1
fi

rm -rf shared/frontary-leptos-static
cp -r "$OUT_DIR/frontary-leptos-static" shared/frontary-leptos-static
echo "✅ Copied to shared/frontary-leptos-static"

# ────────────── Tailwind CSS install ──────────────
echo "📦 Checking Tailwind CSS installation in shared/..."
(
    cd shared

    if [ ! -d "node_modules" ] || [ ! -d "node_modules/tailwindcss" ]; then
        echo "📦 Installing Tailwind CSS dependencies..."
        npm install -D tailwindcss@3 postcss autoprefixer
    else
        echo "✅ Tailwind CSS already installed. Skipping npm install."
    fi
)

# ────────────── Tailwind CSS build ──────────────
echo "🎨 Building Tailwind CSS (shared)..."
(
    cd shared
    npx tailwindcss -i input.css -o static/output.css --config tailwind.config.js
)

STATIC_TARGET_DIR="${TARGET_DIR}/static"
mkdir -p "$STATIC_TARGET_DIR"
cp shared/static/output.css "$STATIC_TARGET_DIR/"

# ────────────── Trunk.toml generator ──────────────
generate_trunk_toml() {
    local path=$1
    local filehash=$2
    local trunk_path="$path/Trunk.toml"
    if [[ ! -f "$trunk_path" ]]; then
        echo "📄 Generating Trunk.toml for $path (filehash=$filehash)..."
        echo -e "[build]\nfilehash = $filehash" > "$trunk_path"
    fi
}

# ────────────── Dummy index.html generator for SSR ──────────────
generate_dummy_html() {
    local dir=$1
    local bin_name=$2
    local html_path="$dir/index.html"

    if [[ ! -f "$html_path" ]]; then
        echo "📄 Generating dummy index.html with data-bin=$bin_name..."
        cat > "$html_path" <<EOF
<!DOCTYPE html>
<html lang="und">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SSR Dummy</title>
  <link data-trunk rel="rust" data-bin="$bin_name" />
</head>
<body></body></html>
EOF
    fi
}

# ────────────── Build CSR app ──────────────
build_csr_app() {
    local app=$1
    local csr_outdir="${TARGET_DIR}/csr/${app}"
    local public_url_csr="/csr/${app}/"
    [[ "$app" == "home" ]] && public_url_csr="/csr/"

    echo "🛠️  Building CSR for $app..."
    mkdir -p "$csr_outdir"
    echo "📁 Trunk build for $app: dist=$csr_outdir, public-url=$public_url_csr"
    ls -al "csr/$app" || echo "⚠️ csr/$app not found"
    (cd "csr/$app" && trunk build $RELEASE --dist "$csr_outdir" --public-url="$public_url_csr") || {
        echo "❌ Trunk CSR build failed for $app"
        exit 1
    }
}

# ────────────── Build SSR app ──────────────
build_ssr_app() {
    local app=$1
    local ssr_outdir="${TARGET_DIR}/ssr/${app}"
    local public_url_ssr="/ssr/${app}/"
    local bin_name="${app}-ssr"
    [[ "$app" == "home" ]] && public_url_ssr="/ssr/"

    echo "🛠️  Building SSR for $app..."
    mkdir -p "$ssr_outdir"
    generate_trunk_toml "ssr/${app}" false
    generate_dummy_html "ssr/${app}" "$bin_name"
    ls -al "ssr/$app" || echo "⚠️ ssr/$app not found"
    (cd "ssr/$app" && trunk build $RELEASE --dist "$ssr_outdir" --public-url="$public_url_ssr") || {
        echo "❌ Trunk SSR build failed for $app"
        exit 1
    }
    echo "🧽 Removing SSR index.html and Trunk.toml for $app..."
    rm -f "ssr/${app}/index.html"
    rm -f "ssr/${app}/Trunk.toml"
}

# ────────────── Build all apps ──────────────
if [[ "$MODE" == "both" || "$MODE" == "csr" ]]; then
    for app in "${APPS[@]}"; do
        echo "🧹 Cleaning $app CSR target directory..."
        rm -rf "${TARGET_DIR}/csr/${app}"
        build_csr_app "$app"
    done
fi

if [[ "$MODE" == "both" || "$MODE" == "ssr" ]]; then
    for app in "${APPS[@]}"; do
        echo "🧹 Cleaning $app SSR target directory..."
        rm -rf "${TARGET_DIR}/ssr/${app}"
        build_ssr_app "$app"
    done
fi

echo "✅ All builds complete."
