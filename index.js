import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import express from 'express';

// --- CONFIGURATION ---
const CATEGORY_IDS = [
    '1429578588218200325',
    '1429462802317181059'
];

// On charge les secrets depuis les variables d'environnement
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET_KEY = process.env.API_SECRET_KEY; 
const PORT = process.env.PORT || 10000;

let latestEmbedData = {};
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

    const nameField = embed.fields.find(f => f.name.includes('Name'));
    const genField = embed.fields.find(f => f.name.includes('Generation'));

    if (!nameField || !genField) {
        console.log(`[LOG] Embed reçu dans ${message.channel.name}, mais champs "Name" ou "Generation" manquants. Ignoré.`);
        return;
    }

    const newName = nameField.value;
    const newGen = genField.value;
    const channelId = message.channel.id;

    const lastEntry = lastProcessedEntry[channelId];

    if (lastEntry && lastEntry.name === newName && lastEntry.generation === newGen) {
        console.log(`[DUPLICATE] Doublon détecté dans ${message.channel.name} (${newName}). Ignoré.`);
        return; 
    }

    console.log(`[NEW] Nouvelle entrée valide dans ${message.channel.name}: ${newName} / ${newGen}`);

    lastProcessedEntry[channelId] = { name: newName, generation: newGen };

    const allExtractedFields = embed.fields.map(field => ({
        name: field.name,
        value: field.value,
        inline: field.inline
    }));
    
    latestEmbedData[channelId] = allExtractedFields;
});

// --- Configuration du Serveur Web (MODIFIÉ) ---
const app = express();

app.get('/', (req, res) => {
    res.status(200).send('Serveur proxy actif et bot en ligne.');
});

app.get('/getdata', (req, res) => {
    // 1. Récupérer l'en-tête d'autorisation
    const authHeader = req.headers['authorization'];
    
    // 2. Extraire la clé (token)
    let receivedKey = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        receivedKey = authHeader.split(' ')[1]; // Prend ce qui est après "Bearer "
    }

    // 3. Vérifier la clé
    if (!receivedKey || receivedKey !== API_SECRET_KEY) {
        console.warn(`[SECURITE] Echec de la requête. Token Bearer invalide ou manquant.`);
        // 401 Unauthorized (Non autorisé - erreur de client)
        return res.status(401).json({ error: 'Accès non autorisé. Token invalide.' });
    }

    // 4. Si la clé est valide, préparer et envoyer les données
    console.log(`[API] Requête valide reçue. Envoi des données...`);
    
    const robloxDataList = [];

    for (const [channelId, fields] of Object.entries(latestEmbedData)) {
        
        const nameField = fields.find(f => f.name.includes('Name'));
        const genField = fields.find(f => f.name.includes('Generation'));

        if (nameField && genField) {
            robloxDataList.push({
                name: nameField.value,
                gen: genField.value
            });
        }
    }
    
    res.json(robloxDataList);
});


// --- Démarrage ---
if (!DISCORD_TOKEN) {
    console.error("ERREUR CRITIQUE: Le 'DISCORD_TOKEN' n'est pas défini dans les variables d'environnement.");
} else if (!API_SECRET_KEY) {
    console.error("ERREUR CRITIQUE: Le 'API_SECRET_KEY' n'est pas défini dans les variables d'environnement.");
} else {
    console.log("Tentative de connexion du bot à Discord...");
    client.login(DISCORD_TOKEN);

    app.listen(PORT, () => {
        console.log(`Serveur web démarré et à l'écoute sur 0.0.0.0:${PORT}...`);
    });
}
