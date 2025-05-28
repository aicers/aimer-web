use shared::Navbar;
use yew::{Html, Renderer, function_component, html};

#[function_component(App)]
fn app() -> Html {
    html! {
        <div>
            <h1>{ "Welcome to the Aimer Home App" }</h1>
            <Navbar />
        </div>
    }
}

fn main() {
    Renderer::<App>::new().render();
}
