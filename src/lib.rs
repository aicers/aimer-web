pub mod admin;
pub mod home;
pub mod user;

pub use home::App;

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_lazy(App);
}

#[cfg(feature = "ssr")]
use leptos::prelude::{
    AutoReload, ElementChild, GlobalAttributes, HydrationScripts, IntoView, LeptosOptions, view,
};

#[cfg(feature = "ssr")]
#[must_use]
pub fn shell(options: LeptosOptions) -> impl IntoView {
    use home::App;
    use leptos_meta::MetaTags;

    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <AutoReload options=options.clone() />
                <HydrationScripts options />
                <MetaTags />
            </head>
            <body>
                <App />
            </body>
        </html>
    }
}
