/**
 * Réglages publics du site (faciles à modifier).
 *
 * Lien de don : priorité à la variable d'environnement Vite `VITE_DONATE_URL`
 * (fichier frontend/.env), sinon la valeur par défaut ci-dessous.
 *
 * Exemple .env :
 *   VITE_DONATE_URL=https://ko-fi.com/skycommunity
 */
export const DONATE_URL =
  (typeof import.meta !== "undefined" && (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_DONATE_URL) ||
  "https://ko-fi.com/skycommunity";

export const DISCORD_INVITE_DEFAULT = "https://discord.gg/xjhTqW3N7d";
