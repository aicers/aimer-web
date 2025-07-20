use leptos::{mount::hydrate_body, view};
use shared::HomeApp;

fn main() {
    hydrate_body(|| view! { <HomeApp prefix="" /> });
}
