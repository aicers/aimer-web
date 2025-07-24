# Aimer Web

**Aimer Web** is a Rust-based multi-application frontend built with [Leptos](https://leptos.dev/)
and [Trunk](https://trunkrs.dev/). It consists of three separate WebAssembly applications,
each mounted at a distinct route and served by a backend using [Axum](https://github.com/tokio-rs/axum/).

Aimer Web adopts a hybrid rendering strategy: **Client-Side Rendering (CSR)** is
used during development to enable rapid iteration and fast feedback, while
**Server-Side Rendering (SSR)** is used in production to maximize performance, SEO,
and initial load speed, without compromising development speed.

Unlike the typical SSR architecture where frontend and backend are tightly coupled
in a single repository, Aimer Web keeps the two **cleanly decoupled across separate
repositories**. This design preserves the core benefits of SSR while ensuring
modularity, maintainability, and a more stable development workflow.

## Applications

### **Home App**

- The default entry point of the web UI
- Provides navigation links to Admin and User Apps
- Handles authentication

### **Admin App**

- Configuration and management interface
- Secure interface for authorized users only

### **User App**

- Main analysis dashboard
- Heavy GraphQL interaction

### Requirements

- Rust
- Trunk (`cargo install trunk`)
- WASM target installed:

  ```bash
  rustup target add wasm32-unknown-unknown
  ```

## SSR and CSR Strategy

- The backend daemon is built with **Axum**, and it serves both SSR and CSR outputs
  simultaneously.
- In **production**, SSR is the default. When you visit `https://hostname/`,
  the SSR-rendered Home app is served.
- In **development**, CSR is used to avoid rebuilding the Aimer backend every time
  you update the frontend. Instead, the backend remains running, and you can test
  changes by rebuilding only Aimer Web and reloading the browser.

## Workflow

1. During development, build only the CSR version:
   - CSR apps are served at:
     - `https://hostname/csr/` → Home
     - `https://hostname/csr/admin/`
     - `https://hostname/csr/user/`

2. Once frontend development is complete:
   - Run a full **SSR build**
   - Publish the resulting output
   - Update the Aimer backend to use the newly built SSR output
   - Deploy both together for production

## How Routing Works

- **SSR routing**
  - `/` serves the Home SSR app
  - `/admin` and `/user` serve the Admin and User SSR apps respectively

- **CSR routing**
  - `/csr/`, `/csr/admin/`, `/csr/user/` serve CSR apps
  - Use `<base href="/csr/">` in your `index.html` for CSR home to ensure paths
    resolve correctly

## Shared Code

All application UIs (`HomeApp`, `AdminApp`, `UserApp`) are defined in the `shared/`
crate and reused across SSR and CSR targets to reduce duplication and ensure consistency.

## Tailwind CSS

This project relies exclusively on Tailwind CSS for modern styling. To use these
styles, you must install the necessary Tailwind tools and follow the steps below
to generate the final Tailwind output.

### Install Node (if you haven't already)

#### macOS

```bash
brew install node
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install nodejs npm
```

### Install Tailwind in `shared`

```bash
cd shared
npm install -D tailwindcss@3 postcss autoprefixer
```

> ⚠️ You must install these dependencies inside `shared` because they are not used
  globally. Install them locally in each directory where you generate Tailwind CSS.
> ⚠️ We use Tailwind CSS v3 because newer versions (e.g. v4) may cause compatibility
  issues.

A `package.json` is already included, so you **do not** need to run `npm init`.
(Running `npm init -y` to generate a `package.json` is the usual first step, but
this has already been done for you.)

### Use Styles from `frontary-leptos`

When you specify the desired version of `frontary-leptos` in `shared/Cargo.toml`,
`shared/build.rs` will run as needed (using caching so it only executes when required)
and generate the necessary static files under the `target` directory. You must
then copy these files from `target` to `shared/frontary-leptos-static`. This can
be done manually, or you can let the `build.sh` script handle it automatically
during the build process.

```text
shared/frontary-leptos-static/input.frontary.css
shared/frontary-leptos-static/tailwind.frontary.safelist.json
shared/frontary-leptos-static/tailwind.frontary.theme.json
```

These files must be referenced correctly to generate the final Tailwind CSS output.
See `shared/input.css` and `shared/tailwind.config.js` for examples of how to include
them.

### Customize Tailwind Styles

To customize your styles, add your desired utility classes, components, or theme
extensions to `input.css` and `tailwind.config.js` in the `shared` directory. If
you use any classes dynamically (e.g., generated at runtime), be sure to include
them in the `safelist` section of `tailwind.config.js` so they are not purged during
the build process.

### Generate Tailwind CSS

```bash
cd shared
npx tailwindcss -i input.css -o static/output.css --config tailwind.config.js
```

This command compiles Tailwind CSS using the `frontary-leptos` theme and outputs
the result to `static/output.css`, which is used by both CSR and SSR builds. You
can run this manually if needed, but typically `build.sh` will handle it for you.
It's usually sufficient to rely on `build.sh` for this step.

## Build Script: `build.sh`

You can build the apps using the provided script. The script supports:

- `--target-dir`: Required output path
- `--mode`: `ssr`, `csr`, or omitted to build both
- `--app`: Specific apps to build (e.g., `home`, `admin`)
- `--release`: Optional flag for release build

### Examples

```bash
# Build all apps (CSR and SSR)
./build.sh --target-dir path/to/web

# Build only CSR
./build.sh --target-dir path/to/web --mode csr

# Build only SSR
./build.sh --target-dir path/to/web --mode ssr

# Build only specific apps
./build.sh --target-dir path/to/web --app home user

# Build in release mode
./build.sh --target-dir path/to/web --mode ssr --release
```

## Directory Structure

```text
aimer-web/
├── build.sh
├── Cargo.lock
├── Cargo.toml
├── csr
│   ├── admin
│   │   ├── Cargo.toml
│   │   ├── index.html
│   │   └── src
│   │       └── main.rs
│   ├── home
│   │   ├── Cargo.toml
│   │   ├── index.html
│   │   └── src
│   │       └── main.rs
│   └── user
│       ├── Cargo.toml
│       ├── index.html
│       └── src
│           └── main.rs
├── README.md
├── shared
│   ├── Cargo.toml
│   ├── build.rs
│   ├── static
│   │   └── output.css
│   └── src
│       ├── admin
│       │   └── app.rs
│       ├── admin.rs
│       ├── home
│       │   └── app.rs
│       ├── home.rs
│       ├── lib.rs
│       ├── user
│       │   └── app.rs
│       └── user.rs
└── ssr
    ├── admin
    │   ├── Cargo.toml
    │   └── src
    │       ├── lib.rs
    │       └── main.rs
    ├── home
    │   ├── Cargo.toml
    │   └── src
    │       ├── lib.rs
    │       └── main.rs
    └── user
        ├── Cargo.toml
        └── src
            ├── lib.rs
            └── main.rs
```

## Copyright

Copyright 2025 ClumL Inc.
