import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import express from 'express';

// --- CONFIGURATION ---
const CATEGORY_IDS = [
    '1429578588218200325',
    '1429462802317181059'
];

const DATA_EXPIRATION_MS = 3 * 60 * 1000;

// On charge les secrets depuis les variables d'environnement
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const AUTHORIZED_ROBLOX_IDS_STRING = process.env.AUTHORIZED_ROBLOX_IDS;
const PORT = process.env.PORT || 10000;

const authorizedUserIds = new Set(
    AUTHORIZED_ROBLOX_IDS_STRING
        ? AUTHORIZED_ROBLOX_IDS_STRING.split(',').map(id => id.trim())
        : []
);

if (authorizedUserIds.size > 0) {
    console.log(`[CONFIG] IDs Roblox autorisés chargés : ${[...authorizedUserIds].join(', ')}`);
} else {
    console.warn("[ATTENTION] Aucun ID Roblox autorisé n'est configuré via AUTHORIZED_ROBLOX_IDS. L'endpoint /getdata échouera systématiquement.");
}

let dataQueue = []; 
let lastProcessedEntry = {};
let channelIdToName = {};
let monitoredChannelIds = new Set();

// Fonction pour nettoyer le markdown
const cleanMarkdown = (text) => {
    if (typeof text !== 'string') return text;
    // Enlève les backticks triples (blocs de code) et simples (inline code)
    return text.replace(/```/g, '').replace(/`/g, '');
};

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
                        console.log(`     -> Surveillance du salon : ${channel.name} (ID: ${channel.id})`);
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

    // Détection des champs
    const nameField = embed.fields.find(f => f.name.includes('Name'));
    const genField = embed.fields.find(f => f.name.includes('Generation'));
    const jobField = embed.fields.find(f => f.name.includes('Job ID'));

    // On vérifie seulement Name et Gen comme champs requis
    if (!nameField || !genField) {
        console.log(`[LOG] Embed reçu dans ${message.channel.name}, mais champs "Name" ou "Generation" manquants. Ignoré.`);
        return;
    }

    // Nettoyage du markdown et gestion du Job ID (optionnel)
    const newName = cleanMarkdown(nameField.value);
    const newGen = cleanMarkdown(genField.value);
    const newJobId = jobField ? cleanMarkdown(jobField.value) : null;
    const channelId = message.channel.id;

    const lastEntry = lastProcessedEntry[channelId];

    // MODIFIÉ : La détection de doublon ignore le 'jobId'
    if (lastEntry && 
        lastEntry.name === newName && 
        lastEntry.generation === newGen) {
        console.log(`[DUPLICATE] Doublon détecté (Name/Gen) dans ${message.channel.name} (${newName}). Ignoré.`);
        return;
    }

    console.log(`[NEW] Nouvelle entrée valide dans ${message.channel.name}: ${newName} / ${newGen} / Job: ${newJobId}`);
    
    // MODIFIÉ : On ne stocke que 'name' et 'gen' pour la détection de doublon
    lastProcessedEntry[channelId] = { 
        name: newName, 
        generation: newGen
        // On ne met PAS le jobId ici
    };

    // On ajoute toujours l'objet complet (avec jobId) à la file d'attente
    dataQueue.push({
        name: newName,
        gen: newGen,
        jobId: newJobId,
        timestamp: Date.now() 
    });
    
    console.log(`[QUEUE] ${dataQueue.length} item(s) au total en mémoire.`);
});

// --- Configuration du Serveur Web ---
const app = express();

app.get('/', (req, res) => {
    res.status(200).send('Serveur proxy actif et bot en ligne.');
});

// ROUTE /getdata
app.get('/getdata', (req, res) => {
    // 1. & 2. Vérification des paramètres
    const { key, userId } = req.query;
    if (!key || !userId) {
        console.warn(`[SECURITE] Requête échouée. Paramètres 'key' ou 'userId' manquants.`);
        return res.status(400).json({ error: "Paramètres 'key' et 'userId' requis dans l'URL." });
    }

    // 3. Vérification de la clé API
    if (key !== API_SECRET_KEY) {
        console.warn(`[SECURITE] Echec de la requête. Clé API invalide.`);
        return res.status(401).json({ error: 'Accès non authentifié. Clé invalide.' });
    }

    // 4. Vérification du UserID Roblox
    if (!authorizedUserIds.has(userId)) {
        console.warn(`[SECURITE] Echec de la requête. UserID Roblox non autorisé : ${userId}.`);
        return res.status(403).json({ error: 'Accès non autorisé pour cet utilisateur.' });
    }

    // 5. Filtrer la liste
    console.log(`[API] Requête valide reçue de l'UserID ${userId}.`);

    const cutoffTime = Date.now() - DATA_EXPIRATION_MS;

    // ÉTAPE 1 : Filtrer les données "fraîches"
    const freshData = dataQueue.filter(item => {
        return item.timestamp > cutoffTime;
    });

    console.log(`[API] ${dataQueue.length} items en mémoire... ${freshData.length} envoyés (< 3 min).`);

    // ÉTAPE 2 : Préparer la réponse pour Roblox (avec jobId)
    const responseData = freshData.map(item => ({
        name: item.name,
        gen: item.gen,
        jobId: item.jobId
    }));
    
    res.json(responseData);

    // ÉTAPE 3 : Nettoyer la file d'attente principale
    dataQueue = freshData;
});


// --- Démarrage ---
if (!DISCORD_TOKEN) {
    console.error("ERREUR CRITIQUE: Le 'DISCORD_TOKEN' n'est pas défini dans les variables d'environnement.");
} else if (!API_SECRET_KEY) {
    console.error("ERREUR CRITIQUE: Le 'API_SECRET_KEY' n'est pas défini dans les variables d'environnement.");
} else if (!AUTHORIZED_ROBLOX_IDS_STRING) {
    console.error("ERREUR CRITIQUE: 'AUTHORIZED_ROBLOX_IDS' n'est pas défini dans les variables d'environnement. (Ex: '123,456')");
} else {
    console.log("Tentative de connexion du bot à Discord...");
    client.login(DISCORD_TOKEN);

    app.listen(PORT, () => {
        console.log(`Serveur web démarré et à l'écoute sur 0.0.0.0:${PORT}...`);
    });
}
