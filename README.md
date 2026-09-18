# Rendez-vous

Page publique de prise de rendez-vous basée sur les disponibilités de votre agenda Google **et** de ceux de vos collègues.

- Le visiteur choisit un créneau libre dans **tous** les agendas configurés, puis renseigne obligatoirement prénom, nom, e-mail et téléphone.
- L'événement est créé dans votre agenda, avec vos collègues et le visiteur comme invités (il apparaît dans leur agenda et Google leur envoie l'invitation par e-mail).
- Un lien **Google Meet** est ajouté par défaut.
- Accès optionnellement protégé par un **mot de passe** simple, défini dans l'admin. Il est mémorisé 30 jours chez le visiteur, et le changer révoque tous les accès déjà donnés.
- Tout se règle dans `/admin` : plages horaires hebdomadaires (plusieurs plages par jour), dates particulières, durée, intervalle entre créneaux, temps tampon, délai minimum, horizon de réservation, nombre max. de RDV par jour, titre/description de l'événement, agendas à vérifier/inviter.

## 1. Créer les identifiants Google (une seule fois)

1. Dans la [Google Cloud Console](https://console.cloud.google.com/), créez un projet (ou prenez un projet existant).
2. **API et services → Bibliothèque** : activez **Google Calendar API**.
3. **API et services → Écran de consentement OAuth** :
   - Type **Interne** si vous êtes sur Google Workspace (le plus simple), sinon **Externe**.
   - En *Externe*, ajoutez votre adresse dans les **utilisateurs de test**, ou publiez l'application. Sinon le jeton expire au bout de 7 jours.
4. **API et services → Identifiants → Créer des identifiants → ID client OAuth** :
   - Type : **Application Web**
   - URI de redirection autorisé : `https://VOTRE-DOMAINE/admin/oauth/callback` (c'est `BASE_URL` + `/admin/oauth/callback`)
5. Copiez l'ID client et le code secret.

## 2. Lancer avec Docker

```bash
cp .env.example .env
# remplir BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_PASSWORD
docker compose up -d --build
```

L'application écoute sur le port `3000` (modifiable avec `HOST_PORT`). En production, mettez-la derrière un reverse proxy HTTPS (Caddy, Traefik, Nginx…) et renseignez `BASE_URL` avec l'URL publique en `https://`.

Les réglages, le jeton Google et le journal des réservations (`bookings.jsonl`) sont stockés dans le volume Docker `rdv-data` (`/data` dans le conteneur).

### Déployer l'image construite par la CI

À chaque push sur `main`, GitHub Actions lance les tests puis publie l'image (amd64 + arm64) sur GitHub Container Registry :

- `ghcr.io/<utilisateur>/rendez-vous:latest` : dernière version de `main`
- `ghcr.io/<utilisateur>/rendez-vous:1.2.0` : pour un tag git `v1.2.0`
- `ghcr.io/<utilisateur>/rendez-vous:sha-abc1234` : un commit précis

Sur le serveur, il suffit de `docker-compose.yml` et `.env`, sans les sources :

```bash
# une seule fois : jeton GitHub (classic) avec le droit read:packages, l'image étant privée
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <utilisateur> --password-stdin

# dans .env : IMAGE=ghcr.io/<utilisateur>/rendez-vous:latest
docker compose pull && docker compose up -d
```

Pour mettre à jour, relancez `docker compose pull && docker compose up -d`.

## 3. Configurer

1. Ouvrez `https://VOTRE-DOMAINE/admin` (identifiant `ADMIN_USER` / mot de passe `ADMIN_PASSWORD`).
2. Cliquez sur **Connecter mon agenda Google** et autorisez l'accès. L'événement sera créé dans l'agenda principal de ce compte.
3. Ajoutez les agendas de vos collègues (adresse e-mail, ou **Parcourir mes agendas…**) :
   - **Vérifier** : leurs créneaux occupés sont exclus. Leur agenda doit être partagé avec vous, au minimum en « Voir uniquement les disponibilités (masquer les détails) ». Dans une même organisation Google Workspace, c'est généralement déjà le cas par défaut.
   - **Inviter** : ils sont ajoutés aux participants de l'événement.
   - Si un agenda n'est pas lisible, un avertissement s'affiche dans le bloc « Compte Google ».
4. Réglez vos horaires, puis cliquez sur **Enregistrer**.

La page publique est à la racine : `https://VOTRE-DOMAINE/`. Elle peut être intégrée dans un site via une `<iframe>`.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `BASE_URL` | URL publique, sans `/` final. Sert à construire l'URI de redirection OAuth. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Identifiants OAuth « Application Web ». |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Accès à `/admin` (HTTP Basic). Sans mot de passe, l'admin est désactivée. |
| `TRUST_PROXY` | Nombre de reverse proxies devant l'app (défaut `1`), pour l'IP réelle utilisée par l'anti-spam. |
| `HOST_PORT` | Port exposé sur l'hôte (docker compose). |

## Fonctionnement

- Les disponibilités sont calculées dans le fuseau configuré (heure d'été/hiver gérée) et affichées au visiteur dans **son** fuseau.
- Juste avant de créer l'événement, le serveur revérifie le créneau auprès de Google : deux visiteurs ne peuvent pas réserver le même créneau.
- Protection anti-spam : champ piège invisible + 5 réservations max. par IP et par quart d'heure (10 essais de mot de passe).
- Avec un mot de passe, l'API des créneaux et de réservation est elle aussi bloquée, pas seulement l'affichage. Le cookie d'accès est `SameSite=Lax` : la page protégée ne fonctionne donc pas dans une `<iframe>` sur un autre domaine.
- Le nombre max. de RDV par jour ne compte que les RDV créés par cette application et encore présents dans votre agenda : un RDV supprimé libère la place.
- Pour annuler ou déplacer un rendez-vous, modifiez l'événement directement dans Google Agenda : les participants sont prévenus par Google.

## Développement

```bash
npm install
cp .env.example .env
npm run dev
npm test
```
