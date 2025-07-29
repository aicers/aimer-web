use frontary_leptos::sample::Button;
use leptos::prelude::{AnyView, ElementChild, IntoAny, view};
use leptos_router::{LazyRoute, lazy_route};

#[derive(Clone)]
pub struct AdminPage;

#[lazy_route]
impl LazyRoute for AdminPage {
    fn data() -> Self {
        Self {}
    }

    #[allow(clippy::used_underscore_binding)]
    fn view(_this: Self) -> AnyView {
        view! {
            <h2>"Admin App"</h2>
            <Button label="Click Me" />
        }
        .into_any()
    }
}
