use leptos::{mount::mount_to_body, view};
use shared::AdminApp;

fn main() {
    mount_to_body(|| view! { <AdminApp prefix="/csr" /> });
}
