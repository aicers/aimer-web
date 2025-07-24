const frontaryTheme = require("./frontary-leptos-static/tailwind.frontary.theme.json");
const frontarySafelist = require("./frontary-leptos-static/tailwind.frontary.safelist.json");

module.exports = {
    content: [
        "./index.html", // static HTML
        "./src/**/*.{rs,html}", // Leptos + WASM Rust files
    ],
    safelist: frontarySafelist,
    theme: {
        extend: frontaryTheme,
    },
    plugins: [],
};
