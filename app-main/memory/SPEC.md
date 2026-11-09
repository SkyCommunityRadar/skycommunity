# SkyCommunity Radar — SPEC (vivante)

## Ce que fait l'app
Radar ATC communautaire (MSFS) en français. Un pilote importe son plan SimBrief (Pilot ID), choisit sa porte/poste ;
l'ATC saisit le roulage en cliquant sur les taxiways ; l'avion suit ce roulage réel puis la route SimBrief. Le serveur
calcule et partage la position (aucune donnée MSFS). Plus aucune donnée de démonstration.

## Architecture
- Backend FastAPI (`backend/`), MongoDB. Routes sous `/api`. Moteur `lib/engine.py` + boucle `lib/ticker.py`.
- Données au sol réelles : `lib/osm.py` interroge l'API Overpass (OpenStreetMap) une fois par aéroport et met en cache
  dans la collection `ground` : postes (parking_position/gate), points d'attente, graphe taxiway/taxilane/runway.
  Roulage = plus court chemin (Dijkstra, pistes pénalisées x4) entre poste → points cliqués (projetés sur le nœud le plus proche).
- Positions aéroport de référence : `backend/data/airports_ref.json` (OurAirports).
- Frontend Vite/React/TS, TanStack Query, polling 2 s. Leaflet + tuiles OSM assombries.

## Rôles / connexion
- Admin = uniquement l'email `ADMIN_EMAIL` (skycommunity50@gmail.com), calculé serveur (`lib/auth.effective_role`).
- Autres comptes : après connexion → page `/mode` : Pilote (toujours) ou ATC (si `atc_allowed`, accordé par l'admin).
  Le mode est dans le JWT (claim `mode`) ; rôle "aucun" tant que non choisi → 403 sur tout sauf /auth.
- Session : cookie httpOnly `skyradar_session` (SameSite=None;Secure;Partitioned en HTTPS) + secours Bearer
  (`x-session-token` → localStorage). `token_version` révoque les sessions (changement de mot de passe, désactivation, retrait ATC).
- Anti brute-force : 8 échecs/email, 30/IP sur 15 min → 429.
- Pilote : crée ses vols (SimBrief), choisit ses postes, déclare ses phases. ATC : roulages, contrôle, phases. Admin : tout + utilisateurs (ATC autorisé, désactivation), forcer statut, suppression, journal, recharger un aéroport OSM.

## Modèle (Mongo)
users {id,email,display_name,atc_allowed,simbrief_id,disabled,token_version,password_hash} · flights {…, dep_gate, arr_gate,
taxi_out/taxi_in {airport,path,seg_names,names,length_nm,points,set_by_name,set_at}, progress, version} · events · ground · simbrief_drafts.

## Positionnement
Préparation/prêt/repoussage : au poste de départ. Roulage : avance à 15 kt sur le tracé ATC, s'arrête au bout (point d'attente).
Décollage depuis la fin du roulage → route SimBrief → atterrissage au début du roulage arrivée → roulage → poste d'arrivée.

## Flux clés
Connexion → Mode → Radar ; Nouveau vol (SimBrief + porte) ; Détail du vol (onglet Roulage : postes + saisie ATC du roulage
par clics, onglet Contrôle ATC, Route, Historique) ; Aéroports (recherche OACI, postes OSM) ; Administration.

## Ajouts (itération 6)
- Mot de passe oublié : `POST /api/auth/forgot {email}` (réponse identique que le compte existe ou non, 3 mails/15 min) → email
  via Emergent Managed Resend (`lib/email.py`, expéditeur « SkyCommunity Radar ») avec lien `https://<site>/reset?token=…`
  (30 min, usage unique, haché en base `password_resets`, TTL). `POST /api/auth/reset {token,new_password}` révoque toutes les sessions.
- Demande d'accès ATC : bouton ATC verrouillé sur /mode → `POST /api/auth/atc-request` (atc_request=pending). Admin >
  Utilisateurs : liste des demandes (Accepter/Refuser), « Retirer l'accès », « Donner l'accès ».
- Sanctions : suspension 24 h / 7 j / 30 j (`banned_until`) ou blocage définitif (`disabled`), motif facultatif ; effet immédiat
  (token_version). Login refusé avec message de date.
- Ajustement de position : `POST /api/flights/{id}/nudge {delta_nm | waypoint: prev|next, version}` — pilote propriétaire ou ATC/admin,
  sur la trajectoire active (roulage ±37 m/±185 m, route ±5/±25 NM, point préc./suiv.).
- Carte du détail : suivi automatique de l'avion (bouton « Suivi de l'avion »), recadrage sol→air au décollage.

## Ajouts (itération 7 — cahier des charges, priorité 1 + partie 2/4/10)
- Bug décollage corrigé : la fenêtre de confirmation restait montée/démontée pendant sa fermeture (voile flou figé). FlightActions garde le Dialog toujours monté et ferme avant d'agir.
- « Terminer le vol » depuis toute phase active (pilote propriétaire ou ATC/admin, confirmation) ; Terminé ≠ Annulé dans l'historique.
- Étapes précédente/suivante : `POST /api/flights/{id}/step {direction, version}` (pas de retour sol↔air ; un pilote ne peut avancer que vers les étapes qu'il a le droit de déclarer).
- Un seul vol actif par pilote (serveur : fetch + confirm SimBrief → 409).
- Porte de départ obligatoire ; porte d'arrivée « souhaitée » (pilote) vs « assignée » (ATC, `arr_gate_by`), un pilote ne peut pas écraser l'assignation ATC.
- Horaires partout « HH:MM UTC » ; « plan de vol SimBrief ».
- Fond de carte Esri World Dark Gray Base (sans rues/commerces) + pistes (gris large) / taxiways (ambre) / taxilanes dessinés depuis OSM.
- Classement `/classement` (`GET /api/leaderboard`) : heures pilote = cale à cale (block_off_at→block_on_at, serveur), heures ATC = présence radar en mode ATC (heartbeat du polling, coupure > 2 min). Niveaux : `LEVELS` dans routers/leaderboard.py (vide pour l'instant).
- Responsive de base : en-tête compact (icônes), radar et détail du vol empilés sur mobile.
## Non réalisé (à faire)
Espaces aériens, positions ATC GND/TWR/APP/CTR et mode contrôlé/non contrôlé par secteur, génération automatique du roulage, vitesse au sol variable (virages/repoussage), strips ATC partagés, rendu des portes selon les captures (non fournies), tests multi-utilisateurs de charge.

## Strips ATC partagés (ajout)
- `GET /api/strips` (ATC/Admin) : un strip par vol actif ; `PUT /api/strips/{flight_id}` (ATC/Admin) :
  transpondeur (4 chiffres 0-7, unique parmi les vols actifs), montée initiale (ft), croisière (FL, pré-rempli
  depuis le plan de vol SimBrief), altitude d'approche (ft), remarques. Stocké dans `flights.strip`, sans
  incrémenter la version du vol ; chaque modification est journalisée (événement `strip`).
- Radar : onglets « Strips ATC / Vols » dans la colonne de gauche (ATC/Admin). Colonnes gauche/droite
  repliables + bouton carte plein écran.
- Confirmation des actions de vol : inline (plus de fenêtre modale → plus de page floutée/figée).
- Carte : fond Esri Dark Gray (zooms régionaux), coupé à partir de z14 ; plan sol OSM style carte
  d'aérodrome (fond marine, taxiways or + noms, pistes claires à largeur réelle + axe pointillé, postes en
  texte blanc, aires de trafic `apron/terminal` si présentes dans OSM).

## Refonte v3 (barre supérieure, Discord, ATC, avis)
- **Shell** : barre supérieure fixe (logo + nom, horloge UTC HH:MM:SS calée sur le serveur, sélecteur Pilote/ATC
  — ATC verrouillé sans autorisation, redirige vers /mode —, bouton Discord, déconnexion avec confirmation inline).
  Barre latérale rétractable (préférence localStorage `sc.sidebar.collapsed`), menus par mode :
  Pilote = Radar / Nouveau vol / Classement / Profil ; ATC = Radar / Historique / Classement / Profil (+ Administration admin).
  Admin : mode d'affichage local (`sc.admin.uimode`), garde tous ses droits.
- **Auth** : Discord OAuth2 (`/api/auth/discord/login|callback|status`, scope identify, state unique en base TTL,
  compte indexé par `discord_id` unique). Email+mot de passe réservé à l'admin (ADMIN_EMAIL) ; en preview seulement,
  `ALLOW_MEMBER_PASSWORD_LOGIN=true` autorise les comptes de test. Logout = jeton révoqué côté serveur
  (`revoked_tokens`, jti) + position ATC fermée.
- **Radar** : aucune route tant qu'aucun vol n'est sélectionné ; sélection = panneau droit (onglets Vol / Strips /
  Vols actifs / Fréquences), pas de recentrage auto (« Centrer sur l'avion »). Étiquette avion = indicatif + statut.
  Fond OpenFreeMap vectoriel (lib/mapStyle.ts, noms latins), worker MapLibre bundlé, fond de secours Esri + message.
  Numéros de piste aux deux seuils (RadarMap.runwayEnds), minZoom 3.
- **Vols contrôlés** : `POST /flights/{id}/claim` (ATC avec position ouverte). Contrôleur actif tant que sa position
  est vivante (heartbeat radar, TTL 180 s) ; pendant ce temps seul lui (ou l'admin) peut agir (`ensure_control`).
- **Repoussage** : direction N/S/E/W obligatoire (`pushback_dir`), déplacement de 60 m en 90 s.
- **Approche** : passage En route → En approche place l'avion à l'entrée de la STAR (fixes `is_sid_star` du navlog
  SimBrief) ; sinon position conservée + note. `sid`/`star` exposés dans le détail.
- **Point d'attente** : `PUT /flights/{id}/holding` génère le roulage OSM poste → point d'attente (422 explicite si impossible).
- **Strips** : filtre OACI → sections Départs / Arrivées, « Vue globale ».
- **Avis** : `GET /reviews/interactions`, `POST /reviews` (interaction réelle = événement ATC sur le vol, 30 j, unique),
  modération admin `GET/PATCH /admin/reviews`. Seuls les avis acceptés comptent / sont publics.
- **Profils publics** : `GET /users/{id}/profile` (/pilotes/:id) sans email ni données sensibles.
- **Historique** : `GET /history` (ATC/Admin) terminés + annulés, filtres q / statut / OACI, durées cale à cale.
- **Classement** : score = heures×10 + vols×4 + jours actifs 30 j×3 + (note−3)×min(avis,10)×2.
- **Sauvegardes** : `.emergent/crons.yml` → `POST /api/cron/backup` (WEBHOOK_CRON_SECRET) → scripts/backup.sh ;
  restauration vérifiable `scripts/restore.sh <archive>` (base `_restore_test` par défaut).
- Espaces aériens : données VATSpy / SimAware (CC BY-SA 4.0) dans backend/data/vatsim, `GET /api/airspaces`.

## Lot 1 — Comptes (reprise hors Emergent, nov. 2026)
- Discord décide de tout : `lib/discord_roles.py` calcule `access {pilote, atc, atc_lead, admin, creator}` depuis les rôles
  du serveur (OAuth scope `guilds.members.read` à la connexion, puis bot `DISCORD_BOT_TOKEN` toutes les 5 min dans
  `current_user`). Rôle perdu → `token_version`+1 (sessions coupées). Sans rôle → connexion refusée, aucun compte créé.
- Créateur = KRD67, `CREATOR_DISCORD_ID` codé en dur (jamais attribuable). Créateur ⊂ admin. Personne ne sanctionne le
  Créateur ; seul le Créateur sanctionne un administrateur.
- Supprimés : connexion email admin, inscription, mot de passe oublié/réinitialisation, changement de mot de passe,
  demande d'accès ATC (et boutons admin « Donner/Retirer l'accès »), `lib/email.py`, dépendance `emergentintegrations`.
- Tests : `POST /auth/test-login {discord_id, display_name, roles}` uniquement si `ALLOW_TEST_LOGIN=true` (jamais en ligne) ;
  SimBrief Pilot ID "1" renvoie alors le plan enregistré `tests/fixture_simbrief_v2.json` (ACA317 CYUL→CYYC).

## Lot 2 — Contrôle ATC (nov. 2026)
- « Prendre en charge » supprimé (`/flights/{id}/claim` retiré). Responsabilité calculée par le serveur (`lib/control.py`) :
  phase → service (sol GND / tour TWR / approche APP / en route CTR) ; délégation APP seul = APP+TWR+GND, APP+TWR → TWR fait
  le sol ; sans position d'aéroport → CTR dont le secteur VATSpy contient l'aéroport ; en route : APP dans 30 NM, sinon CTR.
- Positions : plusieurs par contrôleur (APP+TWR+GND sur un même aéroport ; CTR seul). Ordre APP → TWR → GND vérifié serveur.
  `POST /atc/positions {kind: airport|center, icao, position?, frequency?}`, `GET /atc/frequency` (aperçu avant ouverture),
  `DELETE /atc/positions/{callsign}` ou `/me`. Heartbeat = polling radar ; sans signal 60 s → position libérée (tick moteur).
- Relève (`lib/handover.py`, collection `atc_handovers`) : position fermée/perdue → la position inférieure ouverte (autre
  contrôleur) doit la reprendre : `GET /atc/handovers/me`, `POST /atc/handovers/accept` ; automatique après 2 min.
- Fréquences : `data/frequencies.json` (OurAirports, domaine public, 4 021 aéroports APP/TWR/GND) ; sinon saisie manuelle
  mémorisée (collection `frequencies`). Pas de source pour les CTR : saisie manuelle.
- Permissions (serveur) : ATC = actions/contrôle/position seulement s'il est responsable ; strip modifiable si le vol part de /
  arrive sur une de ses positions (ou son secteur) ou s'il en est responsable ; roulage = contrôleur du sol de l'aéroport ;
  postes = idem départ/arrivée. Pilote : rien quand le vol est contrôlé ; annulation possible à toute phase active si non
  contrôlé (le vol reste, statut Annulé) ; admins gardent la suppression. Point d'attente choisi par clic sur la carte.

## Lot 3 — Carte (nov. 2026)
- Fluidité : rendu Leaflet sur canvas (`preferCanvas`), redessin des couches seulement quand leurs DONNÉES changent
  (signatures dans RadarMap — avant, tout le plan des aéroports était redessiné à chaque polling 2 s et à chaque
  déplacement), icônes d'avions reconstruites seulement si elles changent, secteurs chargés par cases de 5°.
- Autoroutes / routes : apparition progressive (opacité selon le zoom) — invisibles au-dessous de z7, discrètes jusqu'à z11.
- Taxiways : `GET /airports/nearby` + `useNearbyGrounds` : au zoom ≥ 12, le plan OSM des 2 aéroports les plus proches
  du centre (piste ≥ 900 m) se charge automatiquement (quota 30 nouveaux aéroports/h/utilisateur).
  Emprise réelle de l'aéroport (contour OSM aeroway=aerodrome[icao]) au lieu d'un carré fixe de 5 km.
- Pistes : `data/runways.json` (OurAirports, seuils réels + seuils décalés). `lib/runways.py` réécrit les extrémités
  de la route SimBrief : seuil de la piste `plan_rwy` → rotation dans l'axe → +3 NM dans l'axe ; finale 8 NM dans
  l'axe → seuil → roulage à l'atterrissage. Sans `plan_rwy`, piste la mieux orientée. L'alignement et la sortie de
  piste sont projetés sur l'axe (`engine._air`). Les vols importés avant ce lot gardent l'ancien tracé.
- Postes : position réelle (bout du trait d'entrée OSM, centroïde si surface, nœud exact sinon), cap de
  stationnement quand il est déterminable, postes hors de l'aéroport ou à > 460 m des voies écartés.
  `GROUND_VERSION` = 3 : les aéroports déjà en cache sont reconstruits automatiquement à leur prochain affichage.

## Lot 4 — SimBrief (nov. 2026)
- `plan_meta` enrichi à l'import : `dep_name`, `arr_name`, `dep_rwy`, `arr_rwy`, `pdf_url` (seulement une URL
  `https://www.simbrief.com/ofp/flightplans/…pdf` issue de `files.directory` + `files.pdf.link`).
- Détail du vol : `dep_name`, `arr_name`, `dep_rwy`, `arr_rwy`, `has_pdf` ; onglet Route = cartes Départ / Arrivée
  (OACI, nom, piste) + bouton « Consulter le plan de vol SimBrief (PDF) » (nouvel onglet). `GET /flights/{id}/simbrief-pdf`
  vérifie que le PDF existe encore sur simbrief.com, sinon message explicite (404/503).
- Aperçu d'import : pistes prévues affichées. Méta-données du plan affichées avec des libellés français.
- Retrait des modules de développement Emergent (`@emergentbase/overlay`, `@emergentbase/visual-edits`, page d'accueil
  Emergent `Home.tsx`) : le projet s'installe sans les serveurs d'Emergent.

## Lot 5 — Interface (nov. 2026)
- Accueil (/login) refait : composition centrée et symétrique (logo, titre, carte de connexion Discord, 3 atouts),
  fond « scope radar » animé (désactivé si l'utilisateur préfère moins d'animations). Plus aucune connexion par email.
- Panneau de vol unique `components/FlightPanel.tsx` (radar ET page plein écran) : onglets Détails / Roulage / Route /
  Historique (+ Contrôle) ; cliquer un avion ou ouvrir `/?f=<id>` affiche directement ce panneau. Interactions carte
  partagées dans `lib/useFlightEditing.ts` (saisie du roulage, point d'attente, recalage) — aussi depuis le radar.
- Actions regroupées par fonction (`FlightActions`) : progression (grands boutons bleus avec icône), étapes
  (contour), fin/interruption (rouge, à part, confirmation). Résumé (`FlightStrip`) : route avec barre de progression.
- Supprimés : statut « Prêt au départ » (migration auto → Préparation), mention « vN / PROGRESSION ACTIVE »,
  « Prendre en charge » (lot 2). Pilot ID SimBrief retiré du profil public (gardé sur son propre profil).
- Nouveau vol : carte d'import avec le logo SimBrief by Navigraph (`public/simbrief-logo.png`, lien simbrief.com).

## Retouches (nov. 2026)
- Profil : « Vols contrôlés » pour les ATC — le moteur enregistre dans `flights.controllers` chaque contrôleur responsable
  (+ vols plus anciens sur lesquels l'ATC a agi, d'après le journal).
- Accueil : « Le ciel de SkyCommunity, sous vos yeux. »
- SID / STAR : `plan_meta.sid` / `plan_meta.star` à l'import (champs SimBrief `sid_ident` / `star_ident`, sinon premier
  / dernier élément de la route s'il s'agit d'une procédure) ; affichées « Aucune » si le plan n'en a pas.

## Lot 6 — Planning ATC (nov. 2026)
- Collections `planning` (disponibilités : date UTC, airport|center, OACI, APP/TWR/GND/CTR, fréquence auto ou saisie,
  début/fin UTC) et `planning_requests` (pending / accepted / refused, `decided_by`, `decided_at`, commentaire).
- `routers/planning.py` : `GET /planning?start&days`, `POST /planning` (ATC/admin, pour soi, ≤ 28 jours, pas de chevauchement
  sur la même position, pas de cumul sur deux aéroports au même moment), `POST /planning/{id}/requests` (propriétaire
  uniquement, une demande en attente à la fois, appliquée seulement après validation), `GET /planning/requests`,
  `PATCH /planning/requests/{id}` (admin / Responsable ATC, revalide au moment d'accepter), `DELETE /planning/{id}`
  (admin / Responsable ATC uniquement). Journalisé.
- Page `/planning` (menu « Planning ATC », visible par tous, publication en mode ATC) : semaine du lundi au dimanche,
  formulaire d'annonce, demandes à valider (ou « mes demandes »), historique des décisions ; badge sur le menu pour
  les demandes en attente.

## Vérification complète (nov. 2026)
- 53 tests serveur (dont rôles Discord simulés via bot, garde de la connexion de test, planning, contrôle ATC, pistes),
  typecheck + lint frontend sans erreur, build de production OK, passage GET sur toutes les routes × 5 rôles sans 5xx.
- Sol OSM : CYUL, CYYC, LFLY, LFLL, LFPO, EGLL chargés ; postes tous dans l'emprise, aucun sur une piste.
- Non vérifiable en local : vraie connexion OAuth Discord + bot réel (clés absentes), fluidité mesurée en images/s
  (panneau navigateur masqué) — 0 blocage > 50 ms mesuré avec 41 avions.
