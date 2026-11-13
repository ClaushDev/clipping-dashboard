import { PageHead } from "../components/ui";
import SoundsTab from "../recycle/SoundsTab";

/** Librería de efectos de sonido que usan el editor y los efectos automáticos (whoosh en los cortes, pops…). */
export default function Sonidos() {
  return (
    <>
      <PageHead title="Sonidos" subtitle="Tu librería de efectos de sonido: la usan el editor y los efectos automáticos de los clips." />
      <SoundsTab />
    </>
  );
}
