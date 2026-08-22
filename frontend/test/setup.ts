import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3000" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
