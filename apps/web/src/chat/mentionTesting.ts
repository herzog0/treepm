import { personLink } from "@treepm/domain";
import { composer, composerShown, pickPerson, placeCursor, typeInComposer } from "./composerTesting.js";

/** Marca uma pessoa como o `@` faz: digita ` @` no fim do texto do campo e escolhe a pessoa na lista (o item entra no texto, com um espaço depois). */
export async function mention(name: string): Promise<void> {
  const field = await composer();
  placeCursor("end", field);
  typeInComposer(/(^|\s)$/.test(composerShown(field)) ? "@" : " @", field);
  await pickPerson(name);
}

/** O texto que a mensagem leva quando o item da pessoa está no texto: o elo `[@Nome](person:id)`. */
export const linkOf = (id: string, name: string) => personLink(id, name);
