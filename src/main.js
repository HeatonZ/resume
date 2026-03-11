import { createApp } from "vue";
import { createPinia } from "pinia";
import { MotionPlugin } from "@vueuse/motion";
import App from "./App.vue";
import "./styles.css";

createApp(App).use(createPinia()).use(MotionPlugin).mount("#app");
