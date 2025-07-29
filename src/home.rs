use leptos::{
    prelude::{
        ElementChild, GlobalAttributes, IntoView, OnAttribute, RwSignal, Set, component, lazy, view,
    },
    task::spawn_local,
};
use leptos_meta::{Stylesheet, Title, provide_meta_context};
use leptos_router::{
    Lazy, StaticSegment,
    components::{Route, Router, Routes},
};

use crate::admin::AdminPage;
use crate::user::UserPage;

// According to https://github.com/leptos-rs/leptos/issues/3172,
// the current leptos version looks having issues with `#[must_use_candidate]`.

#[allow(clippy::must_use_candidate)]
#[component]
#[cfg(any(feature = "ssr", feature = "hydrate"))]
pub fn App() -> impl IntoView {
    provide_meta_context();

    view! {
        <Stylesheet href={"/static/output.css"} />
        <Title text="Welcome to Home" />
        <nav id="nav">
            <a href="/">"Home"</a> " | "
            <a href="/admin">"Admin App"</a> " | "
            <a href="/user">"User App"</a>
        </nav>
        <Router>
            <Routes fallback=|| "Page not found.">
                <Route path=StaticSegment("") view=HomePage />
                <Route path=StaticSegment("admin") view={Lazy::<AdminPage>::new()} />
                <Route path=StaticSegment("user") view={Lazy::<UserPage>::new()} />
            </Routes>
        </Router>
    }
}

#[lazy]
pub fn message() -> String {
    "Welcome to the Home Page".to_string()
}

#[component]
fn HomePage() -> impl IntoView {
    let msg = RwSignal::new("Loading...".to_string());
    view! {
        <button id="First" on:click=move |_| spawn_local(async move { msg.set(message().await); })>"Home"</button>
    }
}
