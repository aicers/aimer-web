use leptos::{mount::mount_to_body, view};
use shared::UserApp;

fn main() {
    mount_to_body(|| view! { <UserApp prefix="/csr" /> });
}
