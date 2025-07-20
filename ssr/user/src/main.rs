use leptos::{mount::hydrate_body, view};
use shared::UserApp;

fn main() {
    hydrate_body(|| view! { <UserApp prefix="" /> });
}
