import en from "./locales/en-US.json";
import pt from "./locales/pt-BR.json";
import es from "./locales/es-ES.json";
export type MessageTree = { [key: string]: string | MessageTree };
export const localeMessages = { "en-US": en, "pt-BR": pt, "es-ES": es };
