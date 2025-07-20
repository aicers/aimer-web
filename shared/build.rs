use std::process::exit;
use std::{fs, path::Path};

use frontary_leptos::static_files::static_files;

fn main() {
    let frontary_tailwind_path: &str = "./frontary-leptos-tailwind";
    if !Path::new(frontary_tailwind_path).is_dir() {
        match fs::create_dir_all(frontary_tailwind_path) {
            Ok(()) => println!("Frontary's static directory was created."),
            Err(e) => {
                eprintln!("Failed to create the Frontary's static directory: {e}");
                exit(1);
            }
        }
    }

    let files = static_files();
    for (name, content) in files {
        let path = format!("{frontary_tailwind_path}/{name}");
        match fs::write(path, content) {
            Ok(()) => println!("{name} exported"),
            Err(e) => eprintln!("failed to export {name}: {e}"),
        }
    }
}
