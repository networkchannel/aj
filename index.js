import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import express from 'express';

const CATEGORY_IDS = [
    '1429578588218200325',
    '1429462802317181059'
];

// --- Variables d'Environnement ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET_KEY = process.env.API_SECRET_KEY; // NOUVEAU: La clé pour ton API
const PORT = process.env.PORT || 10000;

// Structure: { channel_id: { name: "...", gen: "..." } }
// C'est maintenant notre seule source de données.
let lastProcessedEntry = {};

let channelIdToName = {};
let monitoredChannelIds = new Set();

// --- Configuration du Bot Discord ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent 
    ]
});

client.once('clientReady', async () => { 
    console.log(`--- Bot connecté en tant que ${client.user.tag} ---`);

    monitoredChannelIds.clear();
    channelIdToName = {};

    console.log("Recherche des salons à surveiller...");
    for (const categoryId of CATEGORY_IDS) {
        try {
            const category = await client.channels.fetch(categoryId);

            if (category && category.type === ChannelType.GuildCategory) {
                console.log(`  [Catégorie trouvée: ${category.name}]`);
                
                category.children.cache.forEach(channel => {
                    if (channel.type === ChannelType.GuildText) {
                        console.log(`    -> Surveillance du salon : ${channel.name} (ID: ${channel.id})`);
                        monitoredChannelIds.add(channel.id);
                        channelIdToName[channel.id] = channel.name;
                    }
                });
            } else {
                console.log(`  [Erreur] ID ${categoryId} n'est pas une catégorie ou est introuvable.`);
            }
        } catch (error) {
            console.error(`Erreur en fetchant la catégorie ${categoryId}:`, error.message);
        }
    }
    console.log(`--- Surveillance active sur ${monitoredChannelIds.size} salons. ---`);
});

// --- Logique de détection ---
client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;
    if (!monitoredChannelIds.has(message.channel.id)) return;
    if (message.embeds.length === 0) return;

    const embed = message.embeds[0];
    if (!embed.fields || embed.fields.length === 0) return;

    // 2. Extraction dynamique des champs requis
    const nameField = embed.fields.find(f => f.name.includes('Name'));
    const genField = embed.fields.find(f => f.name.includes('Generation'));

    if (!nameField || !genField) {
        console.log(`[LOG] Embed reçu dans ${message.channel.name}, mais champs "Name" ou "Generation" manquants. Ignoré.`);
        return;
    }

    const newName = nameField.value;
    const newGen = genField.value; // Renommé pour correspondre au format `gen`
    const channelId = message.channel.id;

    // 3. Vérification des doublons
    const lastEntry = lastProcessedEntry[channelId];

    if (lastEntry && lastEntry.name === newName && lastEntry.gen === newGen) {
        console.log(`[DUPLICATE] Doublon détecté dans ${message.channel.name} (${newName}). Ignoré.`);
        return;
    }

    // 4. C'est une nouvelle entrée valide !
    console.log(`[NEW] Nouvelle entrée valide dans ${message.channel.name}: ${newName} / ${newGen}`);

    // Mettre à jour le tracker de doublons (notre seule base de données)
    // MODIFIÉ: utilise 'gen' pour correspondre à ton format
    lastProcessedEntry[channelId] = { name: newName, gen: newGen };
});

// --- Configuration du Serveur Web (Express) ---
const app = express();

app.get('/', (req, res) => {
    // --- SÉCURITÉ ---
    // On vérifie le header 'Authorization'
    const authHeader = req.headers['authorization'];
    const expectedAuth = `Bearer ${API_SECRET_KEY}`;

    if (!API_SECRET_KEY || !authHeader || authHeader !== expectedAuth) {
        console.warn(`[SECURITY] Tentative d'accès non autorisé.`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // --- FORMATAGE DE LA RÉPONSE ---
    // Transforme l'objet { "id": {name, gen}, ... } en array [ {name, gen}, ... ]
    const responseArray = Object.values(lastProcessedEntry);
    
    res.json(responseArray);
});

// --- Démarrage ---
if (!DISCORD_TOKEN) {
    console.error("ERREUR CRITIQUE: 'DISCORD_TOKEN' n'est pas défini.");
    process.exit(1);
}
if (!API_SECRET_KEY) {
    console.warn("AVERTISSEMENT: 'API_SECRET_KEY' n'est pas définie. L'API n'est pas sécurisée !");
}

console.log("Tentative de connexion du bot à Discord...");
client.login(DISCORD_TOKEN);

app.listen(PORT, () => {
    console.log(`Serveur web démarré et à l'écoute sur 0.0.0.0:${PORT}...`);
});
