//! Build step: packs the phone app into the program, so the download is one file,
//! and gives the .exe its icon and details (Properties → Details in Windows).

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let phone = root.join("phone");
    println!("cargo:rerun-if-changed={}", phone.display());

    // A table of (path the phone asks for, file contents), included by main.rs.
    let mut files = Vec::new();
    collect(&phone, &mut files);
    files.sort();
    let rows: String = files
        .iter()
        .map(|path| {
            let name = path.strip_prefix(&phone).unwrap().to_string_lossy().replace('\\', "/");
            format!("    ({name:?}, include_bytes!({:?})),\n", path.display().to_string())
        })
        .collect();
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("phone_files.rs"), format!("&[\n{rows}]")).unwrap();

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let icon = root.join("brand").join("player-four.ico");
        println!("cargo:rerun-if-changed={}", icon.display());
        winresource::WindowsResource::new()
            .set_icon(&icon.to_string_lossy().replace('\\', "/"))
            .set("ProductName", "Player Four")
            .set("FileDescription", "Player Four")
            .set("CompanyName", "Orest-Z")
            .set("LegalCopyright", "Made by Orest-Z")
            .compile()
            .expect("couldn't add the icon and details to the .exe");
    }
}

/// Every file of the phone app except tooling config.
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.file_name().is_some_and(|name| name != "tsconfig.json") {
            out.push(path);
        }
    }
}
