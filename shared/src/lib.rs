mod admin;
mod home;
mod user;
pub use admin::app::AdminApp;
pub use home::app::HomeApp;
use leptos::{IntoView, component, prelude::ElementChild, view};
pub use user::app::UserApp;

pub const TAILWIND_CSS_PATH: &str = "/static/output.css";

// According to https://github.com/leptos-rs/leptos/issues/3172,
// the current leptos version looks having issues with `#[must_use_candidate]`.
#[allow(clippy::must_use_candidate)]
#[component]
pub fn Nav<'a>(prefix: &'a str) -> impl IntoView {
    let prefix = prefix.trim_end_matches('/');

    view! {
        <nav>
            <a href=format!("{prefix}/") rel="external">"Home Page"</a>
            " | "
            <a href=format!("{prefix}/admin") rel="external">"Admin Page"</a>
            " | "
            <a href=format!("{prefix}/user") rel="external">"User Page"</a>
        </nav>
    }
}
