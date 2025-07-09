use leptos::{IntoView, component, prelude::ElementChild, view};

use crate::Nav;

#[component]
pub fn UserApp<'a>(prefix: &'a str) -> impl IntoView {
    view! {
        <Nav prefix />
        <div>
            <h1>"User App"</h1>
        </div>
    }
}
