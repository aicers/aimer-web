# Aimer Web

Aimer Web is a Rust-based multi-application frontend built with [Yew](https://yew.rs/)
and [Trunk](https://trunkrs.dev/). It consists of three separate WebAssembly
single-page applications (SPAs), each mounted at a distinct route and served by
a backend using [Poem](https://poem.rs/).

## Applications

### **Home App** (`/`)

- The default entry point of the web UI
- Provides navigation links to Admin and Aimer (Analysis)
- Lightweight and fast-loading

### **Aimer App** (`/aimer/`)

- Main analysis dashboard
- Heavy GraphQL interaction

### **Admin App** (`/admin/`)

- Configuration and management interface
- Secure interface for authorized users only

## Build System

You can build each of the apps individually or all at once using the `build.sh`
script located at the root of the repository.

### Requirements

- Rust
- Trunk (`cargo install trunk`)
- WASM target installed:

  ```bash
  rustup target add wasm32-unknown-unknown
  ```

## Usage

```bash
./build.sh [APP]... --target-dir <output-dir> [--release]
```

### Arguments

- `APP`: `home`, `aimer`, or `admin`. You can specify multiple or leave blank to
  build all.
- `--target-dir`: **(required)** Absolute or relative path to store built output.
- `--release`: Optional flag to enable optimized release builds.

### Examples

Build all apps to `/tmp/web-dist` in dev mode:

```bash
./build.sh --target-dir /tmp/web-dist
```

Build only `aimer` and `admin` in release mode:

```bash
./build.sh aimer admin --target-dir ./dist --release
```

## Directory Structure

```text
aimer-web/
├── apps/
│   ├── home/
│   ├── aimer/
│   └── admin/
├── shared/
└── build.sh
```

## Copyright

Copyright 2025 ClumL Inc.
