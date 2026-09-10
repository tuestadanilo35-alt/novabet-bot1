const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    PermissionsBitField, 
    ChannelType 
} = require('discord.js');
const fs = require('fs');
const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const ROL_CAPITAN_NOMBRE = 'Capitán';
const ROLES_STAFF = ['ADMINS | NOVA BET', 'OWNERS | NOVA BET', 'ADM | FILA'];
const CATEGORIA_PARTIDAS_ID = '1544471540215717939'; 
const STATS_FILE = './stats.json';

const colas = new Map();
const partidasActivas = new Map();
const estadoComienzo = new Map();

function cargarStats() {
    if (!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({}, null, 4));
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
}

function guardarStats(datos) {
    fs.writeFileSync(STATS_FILE, JSON.stringify(datos, null, 4));
}

function obtenerOIniciarUsuario(userId, db) {
    if (!db[userId]) {
        db[userId] = { 
            coins: 0, 
            jugadas: 0, 
            ganadas: 0, 
            rachaActual: 0, 
            rachaMaxima: 0, 
            historial: [],
            sanciones: [],
            bloqueadoFilas: false
        };
    }
    return db[userId];
}

function esStaff(member) {
    return member.roles.cache.some(r => ROLES_STAFF.includes(r.name));
}

async function enviarYBorrar(channel, contenido) {
    try {
        const msg = await channel.send(contenido);
        setTimeout(() => msg.delete().catch(() => {}), 7000);
    } catch (e) {}
}

function registrarResultado(ganadorId, perdedorId, modalidad) {
    const db = cargarStats();
    const fecha = new Date().toLocaleDateString('es-ES');

    const ganador = obtenerOIniciarUsuario(ganadorId, db);
    const perdedor = obtenerOIniciarUsuario(perdedorId, db);

    ganador.coins += 2;
    ganador.jugadas += 1;
    ganador.ganadas += 1;
    ganador.rachaActual += 1;
    if (ganador.rachaActual > ganador.rachaMaxima) ganador.rachaMaxima = ganador.rachaActual;
    ganador.historial.unshift(`🟢 Victoria vs <@${perdedorId}> (${modalidad}) - ${fecha}`);
    if (ganador.historial.length > 5) ganador.historial.pop();

    perdedor.jugadas += 1;
    perdedor.rachaActual = 0;
    perdedor.historial.unshift(`🔴 Derrota vs <@${ganadorId}> (${modalidad}) - ${fecha}`);
    if (perdedor.historial.length > 5) perdedor.historial.pop();

    guardarStats(db);
    return ganador.coins;
}

async function finalizarYBorrarCanal(channel) {
    try {
        await channel.permissionOverwrites.set([{ id: channel.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }]);
        setTimeout(() => channel.delete().catch(() => {}), 3000);
    } catch (e) {}
}

function getColaModalidad(modalidad) {
    if (!colas.has(modalidad)) colas.set(modalidad, { fila_1: [], fila_2: [], fila_3: [] });
    return colas.get(modalidad);
}

function crearEmbedFila(modalidad) {
    const estado = getColaModalidad(modalidad);
    const f1 = estado.fila_1.length ? estado.fila_1.map(u => `• <@${u.id}>`).join('\n') : '*Vacía*';
    const f2 = estado.fila_2.length ? estado.fila_2.map(u => `• <@${u.id}>`).join('\n') : '*Vacía*';
    const f3 = estado.fila_3.length ? estado.fila_3.map(u => `• <@${u.id}>`).join('\n') : '*Vacía*';

    return new EmbedBuilder()
        .setTitle(`${modalidad} | ¿Buscando Partida?`)
        .setDescription(`🟢 **Fila 1 (${estado.fila_1.length}/2)**\n${f1}\n\n🟡 **Fila 2 (${estado.fila_2.length}/2)**\n${f2}\n\n🔵 **Fila 3 (${estado.fila_3.length}/2)**\n${f3}`)
        .setColor('#2ECC71');
}

function crearBotonesFila(modalidad) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`f1_${modalidad}`).setLabel('Fila 1').setStyle(ButtonStyle.Success).setEmoji('🟢'),
        new ButtonBuilder().setCustomId(`f2_${modalidad}`).setLabel('Fila 2').setStyle(ButtonStyle.Primary).setEmoji('🟡'),
        new ButtonBuilder().setCustomId(`f3_${modalidad}`).setLabel('Fila 3').setStyle(ButtonStyle.Secondary).setEmoji('🔵'),
        new ButtonBuilder().setCustomId(`salir_${modalidad}`).setLabel('Salir').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );
}

client.once('ready', () => console.log(`🤖 Bot 1 conectado como ${client.user.tag}`));

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // COMANDOS GLOBALES Y DE ADMIN
    if (command === '!setup-filas') {
        if (!esStaff(message.member)) return;
        for (const m of ['1v1', '2v2', '3v3', '4v4', '5v5', '6v6']) {
            await message.channel.send({ embeds: [crearEmbedFila(m)], components: [crearBotonesFila(m)] });
        }
        return message.delete().catch(() => {});
    }

    if (['.coins', '!coins'].includes(command)) {
        const u = message.mentions.users.first() || message.author;
        const db = cargarStats();
        const data = obtenerOIniciarUsuario(u.id, db);
        await enviarYBorrar(message.channel, { content: `🪙 **${u.username}** tiene **${data.coins}** Coins.` });
        return message.delete().catch(() => {});
    }

    if (['.addcoins', '!addcoins', '.+', '!+'].includes(command)) {
        if (!esStaff(message.member)) return;
        const u = message.mentions.users.first();
        const cant = parseInt(args[2] || args[1]);
        if (u && !isNaN(cant)) {
            const db = cargarStats();
            const data = obtenerOIniciarUsuario(u.id, db);
            data.coins += cant;
            guardarStats(db);
            await enviarYBorrar(message.channel, { content: `✅ Se añadieron **${cant}** coins a **${u.username}**.` });
        }
        return message.delete().catch(() => {});
    }

    if (['.removecoins', '!removecoins', '.-', '!-'].includes(command)) {
        if (!esStaff(message.member)) return;
        const u = message.mentions.users.first();
        const cant = parseInt(args[2] || args[1]);
        if (u && !isNaN(cant)) {
            const db = cargarStats();
            const data = obtenerOIniciarUsuario(u.id, db);
            data.coins = Math.max(0, data.coins - cant);
            guardarStats(db);
            await enviarYBorrar(message.channel, { content: `🔻 Se quitaron **${cant}** coins a **${u.username}**.` });
        }
        return message.delete().catch(() => {});
    }

    if (command === '.stats') {
        const u = message.mentions.users.first() || message.author;
        const db = cargarStats();
        const data = obtenerOIniciarUsuario(u.id, db);
        const wr = data.jugadas > 0 ? ((data.ganadas / data.jugadas) * 100).toFixed(1) : '0.0';

        const embed = new EmbedBuilder()
            .setTitle(`📊 STATS: ${u.username.toUpperCase()}`)
            .addFields(
                { name: '🎮 Jugadas', value: `${data.jugadas}`, inline: true },
                { name: '🏆 Ganadas', value: `${data.ganadas}`, inline: true },
                { name: '💀 Perdidas', value: `${data.jugadas - data.ganadas}`, inline: true },
                { name: '🔥 Racha Actual', value: `${data.rachaActual}`, inline: true },
                { name: '👑 Racha Máx', value: `${data.rachaMaxima}`, inline: true },
                { name: '📈 Win Rate', value: `${wr}%`, inline: true },
                { name: '🪙 Coins', value: `${data.coins}`, inline: false }
            ).setColor('#F1C40F');

        await enviarYBorrar(message.channel, { embeds: [embed] });
        return message.delete().catch(() => {});
    }

    if (command === '.historial') {
        const u = message.mentions.users.first() || message.author;
        const db = cargarStats();
        const data = obtenerOIniciarUsuario(u.id, db);
        const hText = data.historial.length ? data.historial.join('\n') : '*Sin historial reciente.*';

        const embed = new EmbedBuilder().setTitle(`📜 HISTORIAL DE ${u.username.toUpperCase()}`).setDescription(hText).setColor('#3498DB');
        await enviarYBorrar(message.channel, { embeds: [embed] });
        return message.delete().catch(() => {});
    }

    // COMANDOS DE TEXTO DENTRO DE LAS SALAS DE PARTIDA
    const info = partidasActivas.get(message.channel.id);
    if (!info) return;

    const capitan1 = info.capitan1;
    const capitan2 = info.capitan2;

    if (command === '.comenzar') {
        if (![capitan1, capitan2].includes(message.author.id)) return;
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('🚀 ¡PARTIDA INICIADA!').setColor('#2ECC71')] });
    }

    if (command === '.win') {
        if (![capitan1, capitan2].includes(message.author.id)) return;
        const perdedorId = message.author.id === capitan1 ? capitan2 : capitan1;
        const total = registrarResultado(message.author.id, perdedorId, info.modalidad);
        
        await message.channel.send({ 
            embeds: [new EmbedBuilder()
                .setTitle('🏆 VICTORIA CONFIRMADA')
                .setDescription(`Ganador: <@${message.author.id}> (+2 Coins, Total: ${total})\n\n🔒 *Eliminando canal...*`)
                .setColor('#2ECC71')] 
        });
        await finalizarYBorrarCanal(message.channel);
    }

    if (command === '.cancelar') {
        if (![capitan1, capitan2].includes(message.author.id)) return;
        await message.channel.send({ 
            embeds: [new EmbedBuilder()
                .setDescription('🚫 Partida cancelada por un capitán.\n\n🔒 *Eliminando canal...*')
                .setColor('#E74C3C')] 
        });
        await finalizarYBorrarCanal(message.channel);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const [id1, id2] = interaction.customId.split('_');

    if (['f1', 'f2', 'f3', 'salir'].includes(id1)) {
        await interaction.deferUpdate().catch(() => {});

        const u = interaction.user;
        const db = cargarStats();
        const usuarioData = db[u.id];

        if (id1 !== 'salir' && usuarioData && usuarioData.bloqueadoFilas) {
            return interaction.followUp({ 
                content: '🚫 **Acceso denegado.** Has acumulado sanciones activas y tienes bloqueado el acceso a las filas.', 
                ephemeral: true 
            });
        }

        const estado = getColaModalidad(id2);

        if (id1 === 'salir') {
            ['fila_1', 'fila_2', 'fila_3'].forEach(k => {
                const idx = estado[k].findIndex(x => x.id === u.id);
                if (idx !== -1) estado[k].splice(idx, 1);
            });
            return interaction.message.edit({ embeds: [crearEmbedFila(id2)] });
        }

        const key = id1 === 'f1' ? 'fila_1' : id1 === 'f2' ? 'fila_2' : 'fila_3';
        const ya = ['fila_1', 'fila_2', 'fila_3'].some(k => estado[k].some(x => x.id === u.id));
        if (ya || estado[key].length >= 2) return;

        estado[key].push(u);
        await interaction.message.edit({ embeds: [crearEmbedFila(id2)] });

        if (estado[key].length === 2) {
            const cap1 = estado[key][0];
            const cap2 = estado[key][1];
            estado[key] = [];
            await interaction.message.edit({ embeds: [crearEmbedFila(id2)] });

            const guild = interaction.guild;
            const rolCap = guild.roles.cache.find(r => r.name === ROL_CAPITAN_NOMBRE);
            const m1 = await guild.members.fetch(cap1.id).catch(() => null);
            const m2 = await guild.members.fetch(cap2.id).catch(() => null);

            if (rolCap) {
                if (m1) await m1.roles.add(rolCap).catch(() => {});
                if (m2) await m2.roles.add(rolCap).catch(() => {});
            }

            const overwrites = [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: cap1.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: cap2.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ];

            guild.roles.cache.forEach(r => {
                if (ROLES_STAFF.includes(r.name)) overwrites.push({ id: r.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
            });

            const ch = await guild.channels.create({
                name: `⚔️-${id2}-${cap1.username}-vs-${cap2.username}`,
                type: ChannelType.GuildText,
                parent: CATEGORIA_PARTIDAS_ID !== 'AQUÍ_ID_DE_LA_CATEGORIA' ? CATEGORIA_PARTIDAS_ID : null,
                permissionOverwrites: overwrites
            });

            partidasActivas.set(ch.id, { capitan1: cap1.id, capitan2: cap2.id, modalidad: id2 });

            const embedInstrucciones = new EmbedBuilder()
                .setTitle(`⚔️ ¡PARTIDA ENCONTRADA (${id2})!`)
                .setDescription(`🔴 **Capitán 1:** <@${cap1.id}>\n🔵 **Capitán 2:** <@${cap2.id}>\n\n` +
                    `📌 **COMANDOS DE LA SALA:**\n` +
                    `• **\`.comenzar\`**: Marca que tu equipo está listo.\n` +
                    `• **\`.win\`**: Solicita registrar la victoria.\n` +
                    `• **\`.cancelar\`**: Propone anular el enfrentamiento.\n\n` +
                    `⚠️ *Al finalizar o cancelar, el canal se ocultará y eliminará automáticamente.*`)
                .setColor('#F39C12');

            await ch.send({ content: `<@${cap1.id}> <@${cap2.id}>`, embeds: [embedInstrucciones] });
        }
    }
});

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot en linea 24/7');
}).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
