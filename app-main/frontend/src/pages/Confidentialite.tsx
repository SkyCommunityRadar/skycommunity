import { Link } from "react-router-dom";

import { tr } from "@/lib/i18n";
function S({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-[color:var(--sc-accent-soft)]">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}

/** Public privacy notice (RGPD): what SkyCommunity Radar stores, why, for how long, and how to get it removed. */
export default function Confidentialite() {
  return (
    <div className="min-h-dvh bg-[color:var(--sc-deep)] px-4 py-10" data-testid="privacy-page">
      <article className="mx-auto max-w-2xl space-y-7">
        <header className="space-y-2">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">{tr("← SkyCommunity Radar")}</Link>
          <h1 className="text-2xl font-bold tracking-tight">{tr("Confidentialité et données personnelles")}</h1>
          <p className="text-sm text-muted-foreground">{tr("SkyCommunity Radar est un outil communautaire et bénévole de simulation de vol (Microsoft Flight Simulator). Cette page explique simplement quelles données il utilise, pourquoi, et comment les faire supprimer.")}</p>
        </header>

        <S title={tr("Qui est responsable ?")}>
          <p>{tr("L'équipe de direction de la communauté SkyCommunity, joignable sur le serveur Discord SkyCommunity.")}</p>
        </S>

        <S title={tr("Les données que nous gardons")}>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>{tr("Votre compte Discord")}</b>{" "}{tr(": identifiant, pseudo, nom affiché, avatar et rôles sur le serveur SkyCommunity. Ils servent uniquement à vous connecter et à décider de vos accès (Pilote, ATC, Responsable Pilotes, Responsable ATC, Administrateur). Nous ne recevons jamais votre mot de passe ni votre adresse e-mail Discord.")}</li>
            <li><b>{tr("Votre Pilot ID SimBrief")}</b>{tr(", si vous le renseignez, pour importer vos plans de vol. Il n'est pas affiché publiquement.")}</li>
            <li><b>{tr("Votre activité sur le radar")}</b>{" "}{tr(": vols créés et leur historique, temps passé en position ATC, vols contrôlés, avis donnés et reçus, disponibilités au planning. Ces informations alimentent le radar, l'historique et le classement.")}</li>
            <li><b>{tr("Votre suivi d'activité")}</b>{" "}{tr(": date de votre dernier vol et de votre dernière position ATC, et les absences que vous déclarez (dates et motif). Elle sert à la règle d'inactivité de la communauté (accès suspendu après une longue absence, puis réactivé à la demande) et n'est visible que par vous, le Responsable Pilotes, le Responsable ATC et les administrateurs.")}</li>
            <li><b>{tr("Un journal technique")}</b>{" "}{tr("des actions (qui a fait quoi et quand), pour la modération et la sécurité.")}</li>
          </ul>
          <p>{tr("Les positions des avions sont")}{" "}<b>{tr("simulées")}</b>{" "}{tr("à partir du plan de vol : le site ne lit rien sur votre ordinateur ou votre console.")}</p>
        </S>

        <S title={tr("Ce qui est visible par les autres membres")}>
          <p>{tr("Votre nom affiché, votre avatar, votre niveau, vos statistiques (heures, vols), les avis validés et vos vols sur le radar. Rien n'est visible sans être connecté avec un compte du serveur Discord SkyCommunity.")}</p>
        </S>

        <S title={tr("Cookies")}>
          <p>{tr("Un seul cookie : celui de la")}{" "}<b>{tr("session de connexion")}</b>{tr(", indispensable, illisible par les scripts et supprimé à la déconnexion (7 jours maximum). Quelques préférences d'affichage (menu réduit, mode Pilote/ATC, langue) restent dans votre navigateur.")}{" "}<b>{tr("Aucun cookie publicitaire, aucun traceur, aucune statistique de visite.")}</b>
          </p>
        </S>

        <S title={tr("Services extérieurs utilisés")}>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>{tr("Discord")}</b>{" "}{tr(": connexion et lecture de vos rôles sur le serveur.")}</li>
            <li><b>{tr("SimBrief (Navigraph)")}</b>{" "}{tr(": récupération de votre dernier plan de vol, uniquement quand vous l'importez.")}</li>
            <li><b>{tr("OpenFreeMap / OpenStreetMap")}</b>{" "}{tr(": fonds de carte et plans des aéroports. Votre navigateur télécharge les images de carte directement chez eux (comme sur n'importe quel site avec une carte).")}</li>
          </ul>
          <p>{tr("Vos données ne sont")}{" "}<b>{tr("jamais vendues")}</b>{" "}{tr("ni utilisées pour de la publicité.")}</p>
        </S>

        <S title={tr("Combien de temps ?")}>
          <p>{tr("Tant que votre compte existe. Les adresses IP servent seulement à bloquer les abus (trop de requêtes) et ne sont gardées que quelques minutes en mémoire, jamais enregistrées. Les sauvegardes quotidiennes de la base sont conservées deux semaines puis remplacées.")}</p>
        </S>

        <S title={tr("Vos droits")}>
          <p>{tr("Vous pouvez demander à")}{" "}<b>{tr("voir")}</b>, <b>{tr("corriger")}</b>{" "}{tr("ou")}{" "}<b>{tr("supprimer")}</b>{" "}{tr("vos données à tout moment : écrivez à un administrateur sur le serveur Discord SkyCommunity. La suppression efface votre profil, vos vols et les avis vous concernant. Votre nom affiché et votre Pilot ID SimBrief se modifient aussi directement dans « Mon profil ».")}</p>
          <p>{tr("Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la CNIL (")}<a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener noreferrer" className="text-[color:var(--sc-accent-soft)] underline">{tr("cnil.fr")}</a>).
          </p>
        </S>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">{tr("SkyCommunity Radar n'est affilié ni à Microsoft, ni à Navigraph / SimBrief, ni à Discord. Dernière mise à jour : novembre 2026.")}</p>
      </article>
    </div>
  );
}
