import { loadFont as anton } from "@remotion/google-fonts/Anton";
import { loadFont as archivoBlack } from "@remotion/google-fonts/ArchivoBlack";
import { loadFont as bangers } from "@remotion/google-fonts/Bangers";
import { loadFont as bebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as inter } from "@remotion/google-fonts/Inter";
import { loadFont as lilitaOne } from "@remotion/google-fonts/LilitaOne";
import { loadFont as luckiestGuy } from "@remotion/google-fonts/LuckiestGuy";
import { loadFont as montserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as oswald } from "@remotion/google-fonts/Oswald";
import { loadFont as outfit } from "@remotion/google-fonts/Outfit";
import { loadFont as permanentMarker } from "@remotion/google-fonts/PermanentMarker";
import { loadFont as playfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as poppins } from "@remotion/google-fonts/Poppins";
import { loadFont as rubik } from "@remotion/google-fonts/Rubik";
import { loadFont as teko } from "@remotion/google-fonts/Teko";
import { loadFont as pressStart } from "@remotion/google-fonts/PressStart2P";
import { loadFont as specialElite } from "@remotion/google-fonts/SpecialElite";
import { loadFont as vt323 } from "@remotion/google-fonts/VT323";
// Las letras de las pieles del repo «animaciones», para que la IA las use en las escenas de esos estilos
import { loadFont as tiltNeon } from "@remotion/google-fonts/TiltNeon";
import { loadFont as rajdhani } from "@remotion/google-fonts/Rajdhani";
import { loadFont as shareTechMono } from "@remotion/google-fonts/ShareTechMono";
import { loadFont as ibmPlexMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as caveat } from "@remotion/google-fonts/Caveat";
import { loadFont as kalam } from "@remotion/google-fonts/Kalam";
import { loadFont as architectsDaughter } from "@remotion/google-fonts/ArchitectsDaughter";
import { loadFont as b612 } from "@remotion/google-fonts/B612";
import { loadFont as mochiyPopOne } from "@remotion/google-fonts/MochiyPopOne";
import { loadFont as yujiSyuku } from "@remotion/google-fonts/YujiSyuku";
import { loadFont as bricolage } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as barlowCondensed } from "@remotion/google-fonts/BarlowCondensed";
import { loadFont as cinzel } from "@remotion/google-fonts/Cinzel";
import { loadFont as ebGaramond } from "@remotion/google-fonts/EBGaramond";

type Loader = () => { fontFamily: string };

/** Fuentes de Google disponibles en plantillas y textos. Cualquier otro nombre se toma como fuente del sistema. */
const LOADERS: Record<string, Loader> = {
  Anton: () => anton("normal", { weights: ["400"], subsets: ["latin"] }),
  "Archivo Black": () => archivoBlack("normal", { weights: ["400"], subsets: ["latin"] }),
  Bangers: () => bangers("normal", { weights: ["400"], subsets: ["latin"] }),
  "Bebas Neue": () => bebasNeue("normal", { weights: ["400"], subsets: ["latin"] }),
  Inter: () => inter("normal", { weights: ["400", "700", "900"], subsets: ["latin"] }),
  "Lilita One": () => lilitaOne("normal", { weights: ["400"], subsets: ["latin"] }),
  "Luckiest Guy": () => luckiestGuy("normal", { weights: ["400"], subsets: ["latin"] }),
  Montserrat: () => montserrat("normal", { weights: ["400", "700", "800", "900"], subsets: ["latin"] }),
  Oswald: () => oswald("normal", { weights: ["400", "700"], subsets: ["latin"] }),
  Outfit: () => outfit("normal", { weights: ["400", "700", "900"], subsets: ["latin"] }),
  "Permanent Marker": () => permanentMarker("normal", { weights: ["400"], subsets: ["latin"] }),
  "Playfair Display": () => playfair("normal", { weights: ["400", "700", "900"], subsets: ["latin"] }),
  Poppins: () => poppins("normal", { weights: ["400", "700", "800", "900"], subsets: ["latin"] }),
  Rubik: () => rubik("normal", { weights: ["400", "700", "900"], subsets: ["latin"] }),
  Teko: () => teko("normal", { weights: ["400", "700"], subsets: ["latin"] }),
  "Press Start 2P": () => pressStart("normal", { weights: ["400"], subsets: ["latin"] }),
  "Special Elite": () => specialElite("normal", { weights: ["400"], subsets: ["latin"] }),
  VT323: () => vt323("normal", { weights: ["400"], subsets: ["latin"] }),
  "Tilt Neon": () => tiltNeon("normal", { weights: ["400"], subsets: ["latin"] }),
  Rajdhani: () => rajdhani("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }),
  "Share Tech Mono": () => shareTechMono("normal", { subsets: ["latin"] }),
  "IBM Plex Mono": () => ibmPlexMono("normal", { weights: ["400", "600"], subsets: ["latin"] }),
  Caveat: () => caveat("normal", { weights: ["500", "700"], subsets: ["latin"] }),
  Kalam: () => kalam("normal", { weights: ["400", "700"], subsets: ["latin", "latin-ext"] }),
  "Architects Daughter": () => architectsDaughter("normal", { weights: ["400"], subsets: ["latin"] }),
  B612: () => b612("normal", { weights: ["400", "700"], subsets: ["latin"] }),
  "Mochiy Pop One": () => mochiyPopOne("normal", { weights: ["400"], subsets: ["latin"] }),
  "Yuji Syuku": () => yujiSyuku("normal", { weights: ["400"], subsets: ["latin"] }),
  "Bricolage Grotesque": () => bricolage("normal", { weights: ["500", "700", "800"], subsets: ["latin"] }),
  "Barlow Condensed": () => barlowCondensed("normal", { weights: ["500", "700", "800"], subsets: ["latin"] }),
  Cinzel: () => cinzel("normal", { weights: ["400", "700"], subsets: ["latin"] }),
  "EB Garamond": () => {
    ebGaramond("italic", { weights: ["400"], subsets: ["latin"] });
    return ebGaramond("normal", { weights: ["400", "700"], subsets: ["latin"] });
  },
};

export const GOOGLE_FONTS = Object.keys(LOADERS);
export const SYSTEM_FONTS = ["Arial Black", "Impact", "Segoe UI Black", "Segoe UI", "Verdana", "Georgia"];

const loaded = new Map<string, string>();

/** Devuelve el font-family CSS, cargando la fuente de Google la primera vez. */
export function fontFamily(name: string): string {
  if (loaded.has(name)) return loaded.get(name)!;
  const loader = LOADERS[name];
  const family = loader ? `"${loader().fontFamily}", sans-serif` : `"${name}", sans-serif`;
  loaded.set(name, family);
  return family;
}
