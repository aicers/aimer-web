use yew::prelude::{Html, function_component, html};

#[function_component(Navbar)]
pub fn navbar() -> Html {
    html! {
        <nav>
            <a href="/">{ "Home" }</a><br />
            <a href="/admin/">{ "Admin" }</a><br />
            <a href="/aimer/">{ "Aimer" }</a><br />
        </nav>
    }
}
