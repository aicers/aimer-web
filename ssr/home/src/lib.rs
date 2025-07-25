use leptos::{IntoView, component, mount::hydrate_body, prelude::ElementChild, view};
use leptos_meta::{Stylesheet, Title, provide_meta_context};
use leptos_router::{
    StaticSegment,
    components::{Route, Router, Routes},
};
use shared::HomeApp as SharedHomeApp;

// According to https://github.com/leptos-rs/leptos/issues/3172,
// the current leptos version looks having issues with `#[must_use_candidate]`.
#[allow(clippy::must_use_candidate)]
#[component]
pub fn HomeApp() -> impl IntoView {
    // Provides context that manages stylesheets, titles, meta tags, etc.
    provide_meta_context();

    view! {
        <Stylesheet href={ shared::TAILWIND_CSS_PATH }/>

        <Title text="Welcome to Home (SSR)"/>

        <Router>
            <main>
                <Routes fallback=|| "Page not found.".into_view()>
                    <Route path=StaticSegment("") view=|| view! { <SharedHomeApp prefix = "" /> } />
                </Routes>
            </main>
        </Router>
    }
}

#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    hydrate_body(|| view! { <HomeApp /> });
}
