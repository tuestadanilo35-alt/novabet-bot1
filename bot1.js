const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    PermissionsBitField, 
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');
const User = require('./User');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// CONFIGURACIÓN DE ROLES Y CATEGORÍA
const ROLES_STAFF = ['ADMINS | NOVA BET', 'OWNERS | NOVA BET', 'ADM | FILA'];
const CATEGORIA_FILAS_ID = 'AQUÍ_ID_CATEGORIA_PARTIDAS';

// Estado global de las filas dinámicas
const filasDinamicas = {
    '1': [],
    '2': [],
    '3': []
};

// Configuración por defecto del panel (5v5 como la captura)
let modoActual = '5v5'; 
let limiteJugadoresPorFila = 10; // 5v5 = 10 jugadores por fila para armar la partida
const partidasActivas = new Map();

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Base de datos MongoDB conectada en Bot 1.'))
    .catch(err => console.error('❌ Error al conectar MongoDB:', err));

async function obtenerOIniciarUsuario(userId) {
    let usuario = await User.findOne({ userId });
    if (!usuario) {
        usuario = await User.create({ userId });
    }
    if (!Array.isArray(usuario.sanciones)) usuario.sanciones = [];
    if (usuario.bloqueadoFilas === undefined) usuario.bloqueadoFilas = false;
    return usuario;
}

function esStaff(member) {
    return member.roles.cache.some(r => ROLES_STAFF.includes(r.name));
}

// Generador del Embed idéntico a la imagen recibida
function generarEmbedFilas(modo = '5v5') {
    const renderFila = (num) => {
        const lista = filasDinamicas[num];
        const count = lista.length;
        if (count === 0) {
            return `*Vacía*`;
        }
        return lista.map(id => `<@${id}>`).join(' ');
    };

    return new EmbedBuilder()
        .setTitle(`${modo} | ¿Buscando Partida?`)
        .setDescription(
            `Unite a una de las **3 filas** de **${modo}** haciendo clic en los botones de abajo.\n\n` +
            `🏆 **Formato**\n${modo} Normal\n\n` +
            `🟢 **Fila 1 — ${filasDinamicas['1'].length} jugador(es)**\n${renderFila('1')}\n\n` +
            `🟡 **Fila 2 — ${filasDinamicas['2'].length} jugador(es)**\n${renderFila('2')}\n\n` +
            `🔵 **Fila 3 — ${filasDinamicas['3'].length} jugador(es)**\n${renderFila('3')}`
        )
        .setColor('#2ECC71');
}

function obtenerBotonesPanel() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fila_1').setLabel('Fila 1').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fila_2').setLabel('Fila 2').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fila_3').setLabel('Fila 3').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('salir_fila').setLabel('❌ Salir de la fila').setStyle(ButtonStyle.Danger)
    );
}

// Crear sala al completarse los cupos
async function crearSalaDePartida(jugadores, modo, guild) {
    const cap1 = jugadores[0];
    const cap2 = jugadores[1];
    const capacidadPorEquipo = Math.ceil(jugadores.length / 2);

    const overwrites = [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }
    ];

    jugadores.forEach(id => {
        overwrites.push({ id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
    });

    guild.roles.cache.forEach(r => {
        if (ROLES_STAFF.includes(r.name)) {
            overwrites.push({ id: r.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
        }
    });

    const ch = await guild.channels.create({
        name: `🎮-partida-${modo}-${cap1}`,
        type: ChannelType.GuildText,
        parent: CATEGORIA_FILAS_ID !== 'AQUÍ_ID_CATEGORIA_PARTIDAS' ? CATEGORIA_FILAS_ID : null,
        permissionOverwrites: overwrites
    });

    partidasActivas.set(ch.id, {
        modo: modo,
        capitan1: cap1,
        capitan2: cap2,
        equipo1: [cap1],
        equipo2: [cap2],
        capacidadPorEquipo: capacidadPorEquipo,
        iniciada: false
    });

    const embedInstrucciones = new EmbedBuilder()
        .setTitle(`🎮 PARTIDA DE HABILIDAD: ${modo.toUpperCase()}`)
        .setDescription(`🥊 **Capitán 1:** <@${cap1}>\n🥊 **Capitán 2:** <@${cap2}>\n\n` +
            `📌 **INSTRUCCIONES:**\n` +
            (capacidadPorEquipo > 1 ? `1️⃣ **.team @jugador**: Invita integrantes a tu equipo (Solo capitanes).\n` : '') +
            `2️⃣ **.comenzar**: Ambos capitanes ejecutan para iniciar.\n` +
            `3️⃣ **.win**: El capitán ganador reclama la victoria al finalizar.`)
        .setColor('#3498DB');

    await ch.send({ content: jugadores.map(id => `<@${id}>`).join(' '), embeds: [embedInstrucciones] });
}

client.once('ready', () => console.log(`🤖 Bot 1 conectado como ${client.user.tag}`));

// MANEJO DE BOTONES (SIN MENSAJES EXTRA, ACTUALIZACIÓN VISUAL DIRECTA)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, user, guild } = interaction;
    const userId = user.id;

    // Verificar si el usuario está sancionado/bloqueado
    const pData = await obtenerOIniciarUsuario(userId);
    if (pData.bloqueadoFilas) {
        return interaction.reply({ content: '🚫 Estás bloqueado de las filas por acumular sanciones.', ephemeral: true });
    }

    // BOTÓN DE SALIR
    if (customId === 'salir_fila') {
        for (const num in filasDinamicas) {
            const idx = filasDinamicas[num].indexOf(userId);
            if (idx !== -1) {
                filasDinamicas[num].splice(idx, 1);
            }
        }
        await interaction.update({ embeds: [generarEmbedFilas(modoActual)], components: [obtenerBotonesPanel()] });
        return;
    }

    // BOTONES DE FILA (Fila 1, Fila 2, Fila 3)
    const numFila = customId.replace('fila_', '');
    if (filasDinamicas[numFila]) {
        // Remover de cualquier otra fila previa
        for (const n in filasDinamicas) {
            const idx = filasDinamicas[n].indexOf(userId);
            if (idx !== -1) filasDinamicas[n].splice(idx, 1);
        }

        // Agregar a la fila seleccionada
        filasDinamicas[numFila].push(userId);

        // Si se completa la fila para armar la partida
        if (filasDinamicas[numFila].length >= limiteJugadoresPorFila) {
            const jugadoresPartida = [...filasDinamicas[numFila]];
            filasDinamicas[numFila] = []; // Limpiar fila
            await interaction.update({ embeds: [generarEmbedFilas(modoActual)], components: [obtenerBotonesPanel()] });
            await crearSalaDePartida(jugadoresPartida, modoActual, guild);
            return;
        }

        // Actualizar silenciosamente el panel visual
        await interaction.update({ embeds: [generarEmbedFilas(modoActual)], components: [obtenerBotonesPanel()] });
    }
});

// COMANDOS DENTRO DE LOS CANALES Y CHAT
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // COMANDO PARA CREAR EL PANEL EN EL CANAL (#FILAS)
    if (command === '.panel-filas' || command === '.setup-filas') {
        if (!esStaff(message.member)) return message.channel.send('❌ Solo el Staff puede enviar este panel.');
        message.delete().catch(() => {});

        modoActual = args[1] ? args[1].toLowerCase() : '5v5';
        const numModo = parseInt(modoActual.replace('v', '')) || 5;
        limiteJugadoresPorFila = numModo * 2;

        return message.channel.send({ embeds: [generarEmbedFilas(modoActual)], components: [obtenerBotonesPanel()] });
    }

    // ==========================================
    // COMANDOS DE LA PARTIDA (.team, .comenzar, .win)
    // ==========================================

    if (!message.channel.name.startsWith('🎮-partida-')) return;
    const infoPartida = partidasActivas.get(message.channel.id);
    if (!infoPartida) return;

    // COMANDO .team
    if (command === '.team') {
        if (infoPartida.iniciada) return message.channel.send('❌ La partida ya ha comenzado.');

        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ Solo los capitanes del equipo pueden invitar integrantes.');

        const compañero = message.mentions.users.first();
        if (!compañero || compañero.bot) return message.channel.send('❌ Etiqueta a un jugador válido. Uso: `.team @usuario`');

        const equipoDelCapitan = esCap1 ? infoPartida.equipo1 : infoPartida.equipo2;

        if (equipoDelCapitan.length >= infoPartida.capacidadPorEquipo) return message.channel.send(`❌ Tu equipo está lleno (${infoPartida.capacidadPorEquipo}/${infoPartida.capacidadPorEquipo}).`);
        if (infoPartida.equipo1.includes(compañero.id) || infoPartida.equipo2.includes(compañero.id)) return message.channel.send('❌ El usuario ya está en esta partida.');

        const rowTeam = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('aceptar_equipo').setLabel('Aceptar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('rechazar_equipo').setLabel('Rechazar').setStyle(ButtonStyle.Danger)
        );

        await message.channel.permissionOverwrites.edit(compañero.id, { ViewChannel: true, SendMessages: true });

        const embedInvitacion = new EmbedBuilder()
            .setTitle('📩 INVITACIÓN A EQUIPO')
            .setDescription(`Hola <@${compañero.id}>, ¿quieres formar parte de este equipo con <@${message.author.id}> para jugar **${infoPartida.modo.toUpperCase()}**?`)
            .setColor('#F39C12');

        const msgInvitacion = await message.channel.send({ content: `<@${compañero.id}>`, embeds: [embedInvitacion], components: [rowTeam] });

        const collector = msgInvitacion.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== compañero.id) return i.reply({ content: '❌ Solo el jugador etiquetado puede responder.', ephemeral: true });

            if (i.customId === 'aceptar_equipo') {
                equipoDelCapitan.push(compañero.id);
                await i.update({ content: `✅ <@${compañero.id}> ha aceptado formar parte del equipo.`, embeds: [], components: [] });
                return collector.stop();
            }

            if (i.customId === 'rechazar_equipo') {
                await message.channel.permissionOverwrites.delete(compañero.id).catch(() => {});
                await i.update({ content: `❌ <@${compañero.id}> rechazó la invitación al equipo.`, embeds: [], components: [] });
                return collector.stop();
            }
        });
        return;
    }

    // COMANDO .comenzar
    if (command === '.comenzar') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ Solo los capitanes pueden dar inicio.');
        if (infoPartida.equipo1.length < infoPartida.capacidadPorEquipo || infoPartida.equipo2.length < infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Faltan integrantes en los equipos para completar la modalidad **${infoPartida.modo.toUpperCase()}**.`);
        }

        infoPartida.iniciada = true;
        return message.channel.send('🚀 **¡La partida ha comenzado oficialmente!** Buena suerte.');
    }

    // COMANDO .win (2 COINS POR INTEGRANTE DEL EQUIPO GANADOR)
    if (command === '.win' || command === '.ganador') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2 && !esStaff(message.member)) return message.channel.send('❌ Solo los capitanes o el Staff pueden reclamar victoria.');

        const numGanador = esCap1 ? 1 : 2;
        const equipoGanador = esCap1 ? infoPartida.equipo1 : infoPartida.equipo2;
        const equipoPerdedor = esCap1 ? infoPartida.equipo2 : infoPartida.equipo1;

        const rowWin = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirmar_win').setLabel('Sí (Otorgar Win)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('denegar_win').setLabel('No (Llamar Staff)').setStyle(ButtonStyle.Danger)
        );

        const embedWinMsg = new EmbedBuilder()
            .setTitle('🏆 DECLARACIÓN DE VICTORIA')
            .setDescription(`El capitán <@${message.author.id}> reclama la victoria para el **Equipo ${numGanador}**.\n\n` +
                `❓ **¿Confirmar resultado y entregar 2 Coins a cada integrante del equipo ganador?**`)
            .setColor('#2ECC71');

        const msgWin = await message.channel.send({ embeds: [embedWinMsg], components: [rowWin] });

        const collectorWin = msgWin.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collectorWin.on('collect', async i => {
            if (i.customId === 'confirmar_win') {
                if (!esStaff(i.member) && !equipoPerdedor.includes(i.user.id) && i.user.id !== message.author.id) {
                    return i.reply({ content: '❌ No tienes permisos para confirmar esta victoria.', ephemeral: true });
                }

                for (const uId of equipoGanador) {
                    const pData = await obtenerOIniciarUsuario(uId);
                    pData.coins += 2;
                    pData.ganadas += 1;
                    pData.jugadas += 1;
                    await pData.save();
                }

                for (const uId of equipoPerdedor) {
                    const pData = await obtenerOIniciarUsuario(uId);
                    pData.jugadas += 1;
                    await pData.save();
                }

                await i.update({
                    content: `🏆 **¡Victoria confirmada!** Se le han otorgado **2 Coins** al capitán y a cada integrante del Equipo ${numGanador}.\n🔒 *Cerrando canal en 5 segundos...*`,
                    embeds: [],
                    components: []
                });

                collectorWin.stop();
                setTimeout(() => message.channel.delete().catch(() => {}), 5000);

            } else if (i.customId === 'denegar_win') {
                await i.update({
                    content: `🚨 **DISPUTA ABIERTA**\n<@${i.user.id}> ha rechazado la victoria.\n📢 **Atención Staff:** ${ROLES_STAFF.map(r => `@${r}`).join(' ')}`,
                    embeds: [],
                    components: []
                });
                collectorWin.stop();
            }
        });
        return;
    }
});

// Servidor Web HTTP para mantener activo Render
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot 1 en linea 24/7');
}).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
