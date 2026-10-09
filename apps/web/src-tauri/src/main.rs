#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // No shell, filesystem, process, HTTP or credential plugins are exposed to the webview.
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Bastion desktop failed to start");
}
