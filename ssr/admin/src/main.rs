use leptos::{mount::hydrate_body, view};
use shared::AdminApp;

fn main() {
    hydrate_body(|| view! { <AdminApp prefix="" /> });
}
