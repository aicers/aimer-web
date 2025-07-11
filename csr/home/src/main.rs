use leptos::{mount::mount_to_body, view};
use shared::HomeApp;

fn main() {
    mount_to_body(|| view! { <HomeApp prefix="/csr" /> });
}
