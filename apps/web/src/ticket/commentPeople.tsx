import { createContext, useContext } from "react";
import type { PeopleContext } from "./description/decorations.js";

const CommentPeople = createContext<PeopleContext | undefined>(undefined);

/** Quem se pode marcar com `@` nos comentários deste ticket: quem enxerga o projeto, pela mesma regra do chat (ADR 0058). */
export const CommentPeopleProvider = CommentPeople.Provider;
export const useCommentPeople = (): PeopleContext | undefined => useContext(CommentPeople);
