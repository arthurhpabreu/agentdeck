import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";
export const useNavigationStore = create<{ favorites: string[]; recent: string[]; visit: (id: string) => void; toggleFavorite: (id: string) => void }>()(persist(set => ({
  favorites: [], recent: [],
  visit: id => set(state => ({ recent: [id, ...state.recent.filter(value => value !== id)].slice(0, 100) })),
  toggleFavorite: id => set(state => ({ favorites: state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites, id] })),
}), { name: "agentdeck-navigation-v1", storage: createJSONStorage(() => mirroredPersistStorage) }));
