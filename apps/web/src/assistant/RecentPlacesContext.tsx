import { createContext, useContext } from "react";
import { noRecentPlaces } from "./recentPlaces.js";
import type { RecentPlaces } from "./recentPlaces.js";

const RecentPlacesContext = createContext<RecentPlaces>(noRecentPlaces);

/** O mapa a oferece; sem ele (testes, telas soltas) nada é registrado nem lido. */
export const RecentPlacesProvider = RecentPlacesContext.Provider;
export const useRecentPlaces = (): RecentPlaces => useContext(RecentPlacesContext);
