#[allow(unused_imports)]
use leptos::prelude::IntoMaybeErased;
use leptos::{IntoView, component, prelude::ElementChild, view};

use crate::Nav;

#[component]
pub fn HomeApp<'a>(prefix: &'a str) -> impl IntoView {
    view! {
        <Nav prefix />
        <div>
            <h1>"Home App"</h1>
        </div>
    }
}
