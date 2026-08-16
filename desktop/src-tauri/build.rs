fn main() {
    println!("cargo:rerun-if-env-changed=WINDRES_PREPROCESSOR");
    tauri_build::build()
}
