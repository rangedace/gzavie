import { SlashCommandBuilder } from 'discord.js';

export const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Recherche ou joue une musique depuis une URL ou un texte.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Nom, URL YouTube ou playlist YouTube')
        .setAutocomplete(true)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Passe au morceau suivant de la file.'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Arrête la lecture, vide la file et quitte le vocal.')
].map((command) => command.toJSON());
