/**
 * Réglages modifiables sans toucher au code des composants.
 *
 * Page de don (bouton « Soutenir le projet » de la page d'accueil) :
 *  - pour la changer : définir VITE_DONATE_URL dans frontend/.env (puis relancer le frontend),
 *  - ou modifier la valeur par défaut ci-dessous.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const DONATE_URL: string = (env.VITE_DONATE_URL || "https://ko-fi.com/skycommunity").trim();