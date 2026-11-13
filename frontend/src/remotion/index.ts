// Punto de entrada del bundle de Remotion (lo usa render.mjs, no Vite).
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
