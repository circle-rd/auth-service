import { createApp } from "vue";
import { createPinia } from "pinia";

// Respect saved theme; fall back to OS preference (default dark)
const savedTheme = localStorage.getItem("theme");
const prefersDark =
  savedTheme !== null
    ? savedTheme !== "light"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
if (prefersDark) {
  document.documentElement.classList.add("dark");
}
import { createI18n } from "vue-i18n";
import App from "./App.vue";
import { router } from "./router/index.js";
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import "./style.css";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: { en, fr },
});

const pinia = createPinia();
const app = createApp(App);

app.use(pinia);
app.use(router);
app.use(i18n);

app.mount("#app");
