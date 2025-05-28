use yew::{Html, Renderer, function_component, html};

#[function_component(App)]
fn app() -> Html {
    html! {
        <div>{ "Hello from admin" }</div>
    }
}

fn main() {
    Renderer::<App>::new().render();
}
