# Relier le bot Discord à SkyCommunity Radar

Le site ne parle jamais directement à Discord. Il prépare des **messages prêts à publier**, en français, dans une boîte d'envoi.
Le bot de la communauté vient les chercher régulièrement (par exemple toutes les 30 secondes), les publie, puis confirme l'envoi.

## 1. Le secret partagé

Le secret se met dans `backend/.env` sur le serveur, jamais dans le code ni dans Discord :

```
BOT_API_SECRET=<une longue chaîne aléatoire, 24 caractères minimum>
```

Le bot doit envoyer exactement la même valeur. Tant que ce secret est absent, l'API du bot reste fermée et répond `401`.

## 2. Lire les messages en attente

```
GET /api/bot/outbox?limit=50
Authorization: Bearer <BOT_API_SECRET>
```

La réponse est une liste, du plus ancien au plus récent :

```json
[
  {
    "id": "…",
    "type": "preouverture",
    "target": "annonces",
    "discord_id": null,
    "text": "📡 **Pré-ouverture ATC** : LFPG_TWR (Tour — Paris Charles de Gaulle) sur 118.650, le 07/11 à 19:00 UTC, par KRD67.",
    "payload": { "callsign": "LFPG_TWR", "frequency": "118.650", "start_at": "2026-11-07T19:00:00+00:00" },
    "created_at": "…"
  }
]
```

### Où publier chaque message (`target`)

| target | où le publier |
|---|---|
| `annonces` | le salon des annonces ATC : pré-ouvertures et leurs annulations |
| `responsables_pilotes` | le salon du staff pilotes, ou un message privé au Responsable Pilotes |
| `responsables_atc` | le salon du staff ATC, ou un message privé au Responsable ATC |
| `membre` | un message privé au membre dont l'identifiant Discord est `discord_id` |

### Types de messages (`type`)

| type | contenu |
|---|---|
| `preouverture` | annonce d'une pré-ouverture de position |
| `preouverture_annulee` | annulation d'une pré-ouverture (salon des annonces) |
| `preouverture_demande_annulation` | un contrôleur demande, avec un motif, l'annulation de sa pré-ouverture (envoyé aux responsables ATC) |
| `preouverture_annulation_accept`, `preouverture_annulation_refuse`, `preouverture_annulee_responsable` | réponse du Responsable ATC, envoyée au contrôleur |
| `activite_alerte` | prévient le membre que son accès sera bientôt suspendu pour inactivité |
| `activite_suspension` | accès suspendu pour inactivité : un message au membre et un message aux responsables |
| `activite_demande` | un membre demande la réactivation de son accès (envoyé aux responsables) |
| `activite_reactivate`, `activite_exempt`, `activite_suspend`, `activite_refuse_request` | décision d'un responsable, envoyée au membre |
| `absence` | un pilote ou un ATC déclare une absence de 7 jours ou moins, acceptée automatiquement (pour information, aux responsables) |
| `absence_demande` | demande d'absence de plus de 7 jours, à valider (aux responsables) |
| `absence_frequente` | alerte : ce membre s'absente souvent, soit 3 absences ou 30 jours sur 90 jours (aux responsables) |
| `absence_accept`, `absence_refuse`, `absence_shorten` | décision du responsable, envoyée au membre |
| `traitee` | la demande annoncée plus tôt vient d'être traitée : voir « Demande traitée » ci-dessous |

Les absences du **staff** restent gérées par le bot, comme avant. Le site ne gère que les absences des pilotes et des ATC.

Le champ `text` est prêt à être publié tel quel. Il se termine par le lien direct vers la bonne page du site (`👉 https://…`), que l'on retrouve aussi seul dans le champ `url`. Le champ `payload` donne les mêmes informations en données, pour faire un embed si besoin.

### Demande traitée

Quand un responsable a traité une demande (réactivation, absence, annulation de pré-ouverture), le site envoie un message
`type: "traitee"` dont le `payload.replaces` contient l'`id` de l'alerte d'origine. Le bot doit alors **modifier le message
Discord qu'il avait publié pour cette alerte**, par exemple en ajoutant « ✅ Traitée par X » ou en le barrant. Les autres responsables voient ainsi que c'est déjà fait. Pour cela, le bot doit garder la correspondance entre l'`id` du site et le message Discord qu'il a publié.

## 3. Confirmer l'envoi

Une fois le message publié :

```
POST /api/bot/outbox/<id>/done
Authorization: Bearer <BOT_API_SECRET>
```

Un message confirmé ne revient plus dans la liste. Un message non confirmé (par exemple si le bot plante) sera proposé à nouveau au passage suivant. Les messages de plus de 30 jours sont effacés automatiquement.

## 4. Rôle « Responsable Pilotes »

Le site doit connaître l'identifiant du rôle Discord « Responsable Pilotes ». Pour le trouver : dans Discord, activez le mode développeur, puis faites un clic droit sur le rôle et choisissez « Copier l'identifiant ». Ajoutez-le ensuite dans `backend/.env` :

```
DISCORD_ROLE_PILOT_LEAD=<identifiant du rôle>
```

Cet identifiant n'est pas un secret. Le rôle « Responsable ATC » est déjà configuré, avec `DISCORD_ROLE_ATC_LEAD`.
