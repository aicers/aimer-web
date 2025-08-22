use std::{env, fs, path::PathBuf, process::exit};

use frontary_leptos::static_files::static_files;

fn main() {
    // Re-run build.rs if these files or directories change
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../../frontary-leptos");

    // OUT_DIR path to hold generated static files
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR environment variable should be set by Cargo"));
    let output_dir = out_dir.join("frontary-leptos-static");

    // Clean and recreate output directory
    if output_dir.exists() {
        println!("cargo:warning=♻️ Cleaning OUT_DIR/frontary-leptos-static...");
        if let Err(e) = fs::remove_dir_all(&output_dir) {
            eprintln!("❗ Failed to remove output dir: {e}");
            exit(1);
        }
    }
    if let Err(e) = fs::create_dir_all(&output_dir) {
        eprintln!("❗ Failed to create output dir: {e}");
        exit(1);
    }

    // Export static files to OUT_DIR
    let files = static_files();
    for (name, content) in files {
        let path = output_dir.join(name);
        if let Some(parent) = path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!("❗ Failed to create directory {}: {e}", parent.display());
                exit(1);
            }
        }
        if let Err(e) = fs::write(&path, content) {
            eprintln!("❗ Failed to write {}: {e}", path.display());
            exit(1);
        }
    }

    println!("✅ Static files exported to OUT_DIR successfully.");
}
