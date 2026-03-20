# Gzavie Discord Music Bot

Bot Discord orienté musique avec commande slash `/play`, limité à YouTube pour garder un socle simple, stable et déployable.

## Fonctionnalités

- `/play <query>`: joue ou recherche une musique YouTube depuis une URL ou un texte libre
- `/skip`: passe au morceau suivant
- `/stop`: arrête la lecture et quitte le vocal
- Support:
  - vidéos YouTube
  - playlists YouTube
  - recherche textuelle YouTube

## Stack

- Node.js 22
- TypeScript
- `discord.js`
- `discord-player`
- Docker
- GitLab CI

## Configuration

Copie `.env.example` vers `.env` puis renseigne:

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
```

Notes:

- `DISCORD_GUILD_ID` n’est pas nécessaire si tu veux des slash commands globales.
- Je ne pars pas sur un token d’app Google ici: pour ce bot, le chemin simple reste YouTube public.

## Démarrage local

```bash
npm install
npm run dev
```

Build de production:

```bash
npm run build
npm start
```

## Docker

Image publiée par la CI GitLab:

```bash
registry.gitlab.com/olivieridamien89/gzavie/gzavie-discord-music-bot:latest
```

Déploiement Portainer:

```bash
docker compose pull
docker compose up -d
```

Le fichier `docker-compose.yml` peut servir de base à une stack Portainer.
Déclare `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` dans l’UI Portainer ou dans l’environnement de la stack.

## GitLab CI

Le pipeline `.gitlab-ci.yml`:

- lance le build TypeScript
- construit l’image Docker
- pousse l’image dans le registry GitLab
