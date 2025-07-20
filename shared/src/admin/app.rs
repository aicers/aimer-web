#[allow(unused_imports)]
use leptos::prelude::IntoMaybeErased;
use leptos::{IntoView, component, prelude::ElementChild, view};

use crate::Nav;

#[component]
pub fn AdminApp<'a>(prefix: &'a str) -> impl IntoView {
    view! {
        <Nav prefix={prefix} />
        <div>
            <h1>"Admin App"</h1>
        </div>
    }
}
