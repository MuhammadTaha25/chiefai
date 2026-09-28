// `node --import ./scripts/register-alias.mjs script.ts` resolves the app's "@/..." imports.
import { register } from "node:module";
register("./alias-hooks.mjs", import.meta.url);
