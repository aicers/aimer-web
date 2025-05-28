#!/bin/bash

set -e

APPS=("home" "aimer" "admin")
TARGETS=()
RELEASE=""
TARGET_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        home|aimer|admin)
            TARGETS+=("$1")
            shift
            ;;
        --release)
            RELEASE="--release"
            shift
            ;;
        --target-dir)
            TARGET_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 [home|aimer|admin] --target-dir PATH [--release]"
            exit 1
            ;;
    esac
done

if [ -z "$TARGET_DIR" ]; then
    echo "Missing required argument: --target-dir PATH"
    echo "Usage: $0 [home|aimer|admin] --target-dir PATH [--release]"
    exit 1
fi

if [ -d "$TARGET_DIR" ]; then
    echo "🧹 Cleaning directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"/*
else
    echo "📁 Creating target directory: $TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
    TARGETS=("${APPS[@]}")
fi

for app in "${TARGETS[@]}"; do
    echo "🔨 Building $app..."

    cd "apps/$app"

    case $app in
        home)
            trunk build $RELEASE --dist "$TARGET_DIR/home"
            ;;
        aimer)
            trunk build $RELEASE --dist "$TARGET_DIR/aimer" --public-url /aimer/
            ;;
        admin)
            trunk build $RELEASE --dist "$TARGET_DIR/admin" --public-url /admin/
            ;;
    esac

    cd - > /dev/null
done

echo "Build complete!"
