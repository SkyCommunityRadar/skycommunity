# SkyCommunity Radar — Installation, déploiement, sauvegarde

Application indépendante : FastAPI (Python 3.11+) + MongoDB 6+ + frontend statique Vite/React. Aucune dépendance à un outil
de génération ; aucun service payant requis (SimBrief = API publique gratuite, tuiles OpenStreetMap = gratuites sous la politique d’usage OSM,
attribution obligatoire, à remplacer par un fournisseur de tuiles propre si le trafic devient important).

## Variables d'environnement (`backend/.env`)
| Variable | Rôle |
|---|---|
| `MONGO_URL` | URI MongoDB (ex. `mongodb://localhost:27017` ou Atlas) |
| `DB_NAME` | nom de la base |
| `CORS_ORIGINS` | origines autorisées (séparées par des virgules) si le frontend est servi sur un autre domaine |
| `JWT_SECRET` | longue valeur aléatoire secrète (signature des sessions) |
| `APP_URL` | adresse publique du site, ex. `https://radar.skycommunity.fr` |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | application Discord (connexion OAuth2) |
| `DISCORD_BOT_TOKEN` | jeton du bot présent sur le serveur : relit les rôles toutes les 5 minutes (SECRET) |
| `DISCORD_GUILD_ID` | (facultatif) identifiant du serveur Discord — par défaut `1476243664098558114` |
| `DISCORD_ROLE_PILOTE`, `DISCORD_ROLE_ATC`, `DISCORD_ROLE_ATC_LEAD`, `DISCORD_ROLE_ADMIN` | (facultatif) identifiants des rôles — valeurs par défaut dans `backend/lib/discord_roles.py` |
| `ALLOW_TEST_LOGIN` | **jamais en production.** `true` uniquement en local pour les tests automatiques (connexion simulée) |

| `COOKIE_SECURE` | `true` en production HTTPS (cookie `Secure`) |

Le cookie de session est toujours `httpOnly` et `SameSite=Lax` ; mettez `COOKIE_SECURE=true` derrière HTTPS.

## Lancer en local
```bash
# Backend
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python seed.py                       # comptes démo + aéroports/vol FICTIFS (idempotent)
uvicorn server:app --host 0.0.0.0 --port 8001
# Frontend
cd frontend && yarn install && yarn dev   # http://localhost:3000, /api proxifié vers :8001
```

## Déploiement indépendant
1. Base : MongoDB Atlas (offre gratuite M0 suffisante pour une communauté) ou un MongoDB auto-hébergé.
2. Backend : n'importe quel hébergeur Python (VPS, Render, Railway, Fly.io…) : `uvicorn server:app --host 0.0.0.0 --port $PORT`.
   **Une seule instance** (le moteur de progression tourne dans le processus) ; si vous montez en charge, isolez `lib/ticker.py`
   dans un worker unique.
3. Frontend : `yarn build` → servir `frontend/dist` (Nginx, Netlify, Vercel…) et router `/api/*` vers le backend
   (reverse proxy) pour garder les cookies sur le même domaine.
4. Lancer `python seed.py` une fois (index de la base).

## Sauvegarde / restauration
```bash
mongodump  --uri "$MONGO_URL" --db "$DB_NAME" --out backup-$(date +%F)
mongorestore --uri "$MONGO_URL" --db "$DB_NAME" --drop backup-AAAA-MM-JJ/$DB_NAME
```
Collections : `users`, `sessions`, `flights`, `events` (journal), `airports`, `simbrief_drafts` (temporaire).

## Données de référence
`backend/data/airports_ref.json` : positions des aéroports (OurAirports, domaine public) pour la recherche OACI. Régénérable depuis https://davidmegginson.github.io/ourairports-data/airports.csv.

## Limites connues
- Positions estimées (pas de télémétrie MSFS). Une future intégration SimConnect/agent local pourra écrire dans la même API.
- Synchronisation par polling (≈2 s) : portable partout ; SSE/WebSocket possible plus tard sans changer le modèle de données.
- SimBrief : API publique non garantie (indisponibilités, limites de débit) — les erreurs sont affichées sans créer de vol.
- Configurations au sol LFPG/LSGG : FICTIVES, à remplacer par des données saisies par la communauté.

## Tests
`cd backend && python -m pytest tests -q` (moteur, parseur SimBrief) ; `cd frontend && yarn typecheck`.

## Connexion Discord et rôles
Tout le monde se connecte avec Discord (plus de connexion par email). Les rôles du serveur décident des accès :
Pilote → Pilote · ATC → ATC · Responsable ATC → ATC + planning · Administrateur → Administrateur ·
compte Discord `1433916473629212865` (KRD67) → Créateur (seul et unique, fixé dans le code). Sans rôle → pas d'accès.
1. https://discord.com/developers/applications → votre application → OAuth2.
2. Redirects : `https://<domaine>/api/auth/discord/callback` (URL exacte). Scopes demandés : `identify guilds.members.read`.
3. Renseigner DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET et DISCORD_BOT_TOKEN (secrets backend). `APP_URL` = domaine public.
4. Le bot doit être membre du serveur SkyCommunity (il lit seulement les rôles d'un membre).
5. Production : ne PAS définir ALLOW_TEST_LOGIN.

## Sauvegardes / restauration
- Automatique : planifier `backend/scripts/backup.sh` une fois par jour (cron système), par exemple
  `15 3 * * * BACKUP_DIR=/srv/skyradar/backups /chemin/vers/backend/scripts/backup.sh` — 14 archives conservées.
  (Chez Emergent, c'était `.emergent/crons.yml` ; ce fichier ne sert plus hors d'Emergent.)
  Le disque du pod n'est pas une sauvegarde hors site : copier régulièrement les archives ailleurs.
- Manuel : `backend/scripts/backup.sh [dossier]`.
- Test de restauration : `backend/scripts/restore.sh <archive>` (restaure dans `<DB>_restore_test`, sans toucher la prod).
- Restauration réelle : `backend/scripts/restore.sh <archive> <DB_NAME>` (écrase la base, --drop).

## Incident
1. Révoquer les sessions : changer JWT_SECRET (déconnecte tout le monde). 2. Suspendre les comptes en cause (Administration).
3. Consulter le journal (Administration → Journal). 4. Restaurer la dernière sauvegarde saine si des données sont altérées.

## Sources de données & licences
- Fond de carte : OpenFreeMap / OpenMapTiles, données © OpenStreetMap (ODbL) — attribution affichée.
- Plans au sol : OpenStreetMap (Overpass). Secteurs : VATSpy Data Project & SimAware TRACON (VATSIM, CC BY-SA 4.0),
  simulation uniquement. IVAO non intégré (API soumise à authentification et conditions restrictives).

## Mise en ligne hors Emergent — liste de contrôle
1. Python 3.11+ et MongoDB 6+ ; `pip install -r backend/requirements.txt` (plus aucune dépendance Emergent).
2. `backend/.env` : MONGO_URL, DB_NAME, JWT_SECRET (long, aléatoire), APP_URL, COOKIE_SECURE=true, DISCORD_CLIENT_ID,
   DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN. **Ne jamais définir ALLOW_TEST_LOGIN** (connexion simulée réservée aux tests).
3. `python seed.py` (index + migrations), puis `uvicorn server:app` — **une seule instance** (moteur + relève ATC).
4. Frontend : `yarn install && yarn build`, servir `frontend/dist` et router `/api/*` vers le backend (même domaine).
5. Discord : URL de redirection `https://<domaine>/api/auth/discord/callback`, bot présent sur le serveur.
6. Premier affichage d'un aéroport : ~1 min (OpenStreetMap / Overpass, gratuit), ensuite en cache dans MongoDB.
7. Sauvegardes : cron quotidien ci-dessus + copie régulière des archives hors du serveur.

## Données embarquées et licences
- `backend/data/airports_ref.json`, `frequencies.json`, `runways.json` : OurAirports (domaine public), régénérables
  depuis https://davidmegginson.github.io/ourairports-data/ (airports.csv, airport-frequencies.csv, runways.csv).
- `frontend/public/simbrief-logo.png` : logo SimBrief by Navigraph (marque de Navigraph), utilisé pour le bouton d'import.

## Sécurité (à lire par l'hébergeur)
Ce que le site fait déjà tout seul :
- **Connexion uniquement par Discord**, accès décidés par les rôles du serveur (relus toutes les 5 min par le bot).
  Un membre sans rôle Pilote / ATC / Administrateur n'a **aucun compte** et ne voit rien.
- **Session** : cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` en HTTPS), jamais lisible par un script ni copié
  dans le navigateur. Déconnexion = jeton révoqué côté serveur.
- **Limites anti-spam par adresse IP** (`backend/lib/security.py`) : 900 requêtes/min au total, 90 modifications/min,
  20 tentatives de connexion/min, 10 imports SimBrief/min, 15 avis/heure, 20 notes/10 min, 40 plans au sol/min.
  Au-delà : erreur 429 « Trop de requêtes », sans bloquer les autres visiteurs.
- Requêtes de plus de 256 ko refusées ; requêtes venant d'un autre site refusées (protection CSRF).
- En-têtes : `X-Frame-Options: DENY`, `nosniff`, HSTS en HTTPS ; documentation de l'API désactivée.
- **Mode anti-raid** (page Administration) : plus aucun nouveau compte, et les comptes créés il y a moins de 24 h
  passent en lecture seule. Les membres déjà là ne voient aucune différence.
- Le serveur **refuse de démarrer** si `JWT_SECRET` fait moins de 32 caractères. La connexion de test n'est jamais
  acceptée ailleurs que sur `localhost`, même si `ALLOW_TEST_LOGIN` était laissé par erreur.

À faire à la mise en ligne :
1. **HTTPS obligatoire** (Let's Encrypt), `COOKIE_SECURE=true`, `APP_URL=https://<domaine>`.
2. Le backend écoute seulement en local (`--host 127.0.0.1`) derrière le reverse proxy ; il reconnaît alors tout
   seul l'adresse réelle des visiteurs (dernière valeur de `X-Forwarded-For` ajoutée par le proxy). Si le proxy est
   sur une autre machine, mettre `TRUST_PROXY=true`.
3. **MongoDB jamais exposé sur Internet** : `bindIp 127.0.0.1`, utilisateur + mot de passe, pare-feu (seuls 80/443 ouverts).
4. En-têtes du site (exemple Nginx, à mettre dans le `server { … }`) :
   ```nginx
   add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn.discordapp.com https://tiles.openfreemap.org https://server.arcgisonline.com; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; child-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
   add_header X-Frame-Options DENY always;
   add_header X-Content-Type-Options nosniff always;
   add_header Referrer-Policy strict-origin-when-cross-origin always;
   add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
   client_max_body_size 256k;
   location /api/ { proxy_pass http://127.0.0.1:8001; proxy_set_header Host $host;
                    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }
   ```
5. Contre les grosses attaques (DDoS) : passer le domaine derrière **Cloudflare** (gratuit), mode proxy activé.
6. Côté Discord (le plus important contre les raids) : ne **jamais** donner le rôle Pilote automatiquement à
   l'arrivée ; niveau de vérification « Élevé » ; AutoMod activé ; le jeton du bot reste uniquement dans `backend/.env`.
7. Vérifier les failles connues des bibliothèques avant chaque mise à jour : `cd frontend && yarn audit` et
   `cd backend && uvx pip-audit -r requirements.txt` (0 faille connue au 6 novembre 2026).

## Appli installable (écran d'accueil du téléphone)
Le site s'installe comme une appli, gratuitement et sans store (`frontend/public/manifest.webmanifest`, `sw.js`,
`offline.html`, `icons/`). Conditions côté hébergeur : **HTTPS obligatoire**, et ne pas mettre `sw.js` en cache longue
durée (exemple Nginx : `location = /sw.js { add_header Cache-Control "no-cache"; }`). Le service worker ne met jamais
les données du radar (`/api/…`) en cache : il affiche seulement une page « Pas de connexion » hors ligne.
