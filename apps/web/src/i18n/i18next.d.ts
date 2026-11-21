import type { Resources } from "./resources.js";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "app";
    resources: Resources;
  }
}
