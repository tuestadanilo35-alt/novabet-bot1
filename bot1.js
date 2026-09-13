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
const NOMBRE_ROL_CAPITAN = 'Capitán'; // Reemplaza por el nombre exacto de tu rol de capitán si cambia
const CATEGORIA_FILAS_ID = 'AQUÍ_ID_CATEGORIA_PARTIDAS';

// Estructura para almacenar las 3 filas de cada modalidad
const MODOS = ['1v1', '2v2', '3v3', '4v4', '5v5', '6v6'];
const estadoFilas = {};

MODOS.forEach(m => {
    estadoFilas[m] = { 1: [], 2: [], 3: [] };
});

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
    if (!Array.isArray(usuario.historial)) usuario.historial = [];
    if (usuario.bloqueadoFilas === undefined) usuario.bloqueadoFilas = false;
    return usuario;
}

function esStaff(member) {
    return member.roles.cache.some(r => ROLES_STAFF.includes(r.name));
}

function esCapitan(member) {
    return member.roles.cache.some(r => r.name === NOMBRE_ROL_CAPITAN);
}

// Generador de Embed para cada modalidad
function generarEmbedModo(modo) {
    const filasModo = estadoFilas[modo];
    const renderFila = (num) => {
        const lista = filasModo[num];
        if (lista.length === 0) return '*Vacía*';
        return lista.map(id => `<@${id}>`).join(' ');
    };

    return new EmbedBuilder()
        .setTitle(`${modo.toUpperCase()} | ¿Buscando Partida?`)
        .setDescription(
            `Unite a una de las **3 filas** de **${modo.toUpperCase()}** haciendo clic en los botones de abajo.\n\n` +
            `🏆 **Formato**\n${modo.toUpperCase()} Normal (2 Capitanes por fila)\n\n` +
            `🟢 **Fila 1 — ${filasModo[1].length}/2 capitán(es)**\n${renderFila(1)}\n\n` +
            `🟡 **Fila 2 — ${filasModo[2].length}/2 capitán(es)**\n${renderFila(2)}\n\n` +
            `🔵 **Fila 3 — ${filasModo[3].length}/2 capitán(es)**\n${renderFila(3)}`
        )
        .setColor('#2ECC71');
}

function obtenerBotonesModo(modo) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fila_${modo}_1`).setLabel('Fila 1').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`fila_${modo}_2`).setLabel('Fila 2').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fila_${modo}_3`).setLabel('Fila 3').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`salir_${modo}`).setLabel('❌ Salir de la fila').setStyle(ButtonStyle.Danger)
    );
}

// Crear sala y asignar ROL CAPITÁN a los 2 elegidos
async function crearSalaDePartida(jugadores, modo, guild) {
    const cap1 = jugadores[0];
    const cap2 = jugadores[1];
    const numJugadoresPorEquipo = parseInt(modo.replace('v', '')) || 1;

    // Buscar y asignar el rol de Capitán
    const rolCapitan = guild.roles.cache.find(r => r.name === NOMBRE_ROL_CAPITAN);
    if (rolCapitan) {
        const member1 = await guild.members.fetch(cap1).catch(() => null);
        const member2 = await guild.members.fetch(cap2).catch(() => null);
        if (member1) await member1.roles.add(rolCapitan).catch(() => {});
        if (member2) await member2.roles.add(rolCapitan).catch(() => {});
    }

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
        capacidadPorEquipo: numJugadoresPorEquipo,
        invitacionesPendientesCap1: 0,
        invitacionesPendientesCap2: 0,
        listoCapitan1: false,
        listoCapitan2: false,
        iniciada: false,
        cancelacionEnProceso: false
    });

    const embedInstrucciones = new EmbedBuilder()
        .setTitle(`🎮 PARTIDA DE HABILIDAD: ${modo.toUpperCase()}`)
        .setDescription(
            `👑 **Capitán 1:** <@${cap1}>\n👑 **Capitán 2:** <@${cap2}>\n\n` +
            `📌 **INSTRUCCIONES:**\n` +
            (modo === '1v1' ? `❌ *El comando .team está deshabilitado en modo 1v1.*\n` : `1️⃣ **.team @jugador**: Invita integrantes a tu equipo (Opcional).\n`) +
            `2️⃣ **.comenzar** (o usa el botón): Ambos capitanes deben confirmar.\n` +
            `3️⃣ **.cancelar** (o usa el botón): Cancela la partida antes de iniciar si el rival acepta.\n` +
            `4️⃣ **.win @jugador**: Reclama la victoria al finalizar.`
        )
        .setColor('#3498DB');

    // Botones rápidos para la sala
    const rowControl = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_comenzar_partida').setLabel('🚀 Comenzar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_cancelar_partida').setLabel('❌ Cancelar Partida').setStyle(ButtonStyle.Danger)
    );

    if (modo !== '1v1') {
        rowControl.addComponents(
            new ButtonBuilder().setCustomId('btn_info_team').setLabel('👥 .team (Ayuda)').setStyle(ButtonStyle.Secondary)
        );
    }

    await ch.send({ content: `<@${cap1}> <@${cap2}>`, embeds: [embedInstrucciones], components: [rowControl] });
}

// Remover rol Capitán al finalizar o cancelar partida
async function quitarRolCapitan(guild, uId) {
    const rolCapitan = guild.roles.cache.find(r => r.name === NOMBRE_ROL_CAPITAN);
    if (!rolCapitan) return;
    const member = await guild.members.fetch(uId).catch(() => null);
    if (member) await member.roles.remove(rolCapitan).catch(() => {});
}

// Función auxiliar para procesar acción de ".comenzar" (desde texto o botón)
async function procesarComenzar(channel, user, guild) {
    const infoPartida = partidasActivas.get(channel.id);
    if (!infoPartida) return;

    if (infoPartida.iniciada) {
        return channel.send('❌ La partida ya ha sido iniciada.');
    }

    const esCap1 = user.id === infoPartida.capitan1;
    const esCap2 = user.id === infoPartida.capitan2;

    if (!esCap1 && !esCap2) {
        return channel.send('❌ Solo un **Capitán** de esta partida puede dar `.comenzar`.');
    }

    const pendientes = esCap1 ? infoPartida.invitacionesPendientesCap1 : infoPartida.invitacionesPendientesCap2;
    if (pendientes > 0) {
        return channel.send('⏳ Tu equipo tiene una invitación de **.team** pendiente. Deben **Aceptar** o **Rechazar** antes de dar `.comenzar`.');
    }

    if (esCap1) infoPartida.listoCapitan1 = true;
    if (esCap2) infoPartida.listoCapitan2 = true;

    if (infoPartida.listoCapitan1 && infoPartida.listoCapitan2) {
        infoPartida.iniciada = true;
        return channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('🚀 ¡PARTIDA INICIADA!')
                    .setDescription('Ambos capitanes están listos. ¡La partida ha comenzado! (El comando `.cancelar` ha sido desactivado).')
                    .setColor('#2ECC71')
            ]
        });
    } else {
        const capFaltante = infoPartida.listoCapitan1 ? infoPartida.capitan2 : infoPartida.capitan1;
        return channel.send(`✅ Capitán <@${user.id}> listo. Esperando a que el Capitán <@${capFaltante}> también confirme con **.comenzar** o presione el botón.`);
    }
}

// Función auxiliar para procesar solicitud de ".cancelar"
async function procesarSolicitudCancelar(channel, user, guild) {
    const infoPartida = partidasActivas.get(channel.id);
    if (!infoPartida) return;

    if (infoPartida.iniciada) {
        return channel.send('❌ **No se puede cancelar:** La partida ya ha comenzado.');
    }

    if (infoPartida.cancelacionEnProceso) {
        return channel.send('⚠️ Ya hay una solicitud de cancelación en curso.');
    }

    const esCap1 = user.id === infoPartida.capitan1;
    const esCap2 = user.id === infoPartida.capitan2;

    if (!esCap1 && !esCap2) {
        return channel.send('❌ Solo los **Capitanes** pueden cancelar la partida.');
    }

    const rivalId = esCap1 ? infoPartida.capitan2 : infoPartida.capitan1;
    infoPartida.cancelacionEnProceso = true;

    const rowCancelar = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_aceptar_cancelar').setLabel('Aceptar Cancelación').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_rechazar_cancelar').setLabel('Rechazar y Continuar').setStyle(ButtonStyle.Success)
    );

    const embedCancel = new EmbedBuilder()
        .setTitle('⚠️ SOLICITUD DE CANCELACIÓN DE PARTIDA')
        .setDescription(`El Capitán <@${user.id}> solicita cancelar la partida.\n\n<@${rivalId}>, ¿aceptas cancelar la partida?`)
        .setColor('#E74C3C');

    const msgCancel = await channel.send({ content: `<@${rivalId}>`, embeds: [embedCancel], components: [rowCancelar] });

    const collectorCancel = msgCancel.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

    collectorCancel.on('collect', async i => {
        if (i.user.id !== rivalId) {
            return i.reply({ content: '❌ Solo el capitán solicitado puede responder a esta cancelación.', ephemeral: true });
        }

        if (i.customId === 'btn_aceptar_cancelar') {
            await quitarRolCapitan(guild, infoPartida.capitan1);
            await quitarRolCapitan(guild, infoPartida.capitan2);
            partidasActivas.delete(channel.id);

            await i.update({
                content: `✅ **Partida Cancelada:** Ambos capitanes acordaron cancelar.\n🔒 *Cerrando canal en 5 segundos...*`,
                embeds: [],
                components: []
            });

            collectorCancel.stop();
            setTimeout(() => channel.delete().catch(() => {}), 5000);
            return;
        }

        if (i.customId === 'btn_rechazar_cancelar') {
            infoPartida.cancelacionEnProceso = false;
            await i.update({
                content: `❌ <@${rivalId}> **RECHAZÓ** la cancelación. La partida continúa normalmente.`,
                embeds: [],
                components: []
            });
            return collectorCancel.stop();
        }
    });

    collectorCancel.on('end', (_, reason) => {
        if (reason === 'time' && infoPartida.cancelacionEnProceso) {
            infoPartida.cancelacionEnProceso = false;
            channel.send('⏳ El tiempo para responder a la solicitud de cancelación expiró. La partida continúa.');
        }
    });
}

client.once('ready', () => console.log(`🤖 Bot 1 conectado como ${client.user.tag}`));

// MANEJO DE BOTONES
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, user, guild, channel } = interaction;
    const userId = user.id;

    // BOTONES EN SALA DE PARTIDA
    if (customId === 'btn_comenzar_partida') {
        await interaction.deferUpdate();
        await procesarComenzar(channel, user, guild);
        return;
    }

    if (customId === 'btn_cancelar_partida') {
        await interaction.deferUpdate();
        await procesarSolicitudCancelar(channel, user, guild);
        return;
    }

    if (customId === 'btn_info_team') {
        return interaction.reply({
            content: '📌 **Cómo agregar compañeros a tu equipo:**\nUsa el comando `.team @usuario` en este chat para invitarlo.',
            ephemeral: true
        });
    }

    // BOTONES DE FILAS
    const pData = await obtenerOIniciarUsuario(userId);
    if (pData.bloqueadoFilas) {
        return interaction.reply({ content: '🚫 Estás bloqueado de las filas por acumular sanciones.', ephemeral: true });
    }

    if (customId.startsWith('salir_')) {
        const modo = customId.replace('salir_', '');
        for (const num in estadoFilas[modo]) {
            const idx = estadoFilas[modo][num].indexOf(userId);
            if (idx !== -1) estadoFilas[modo][num].splice(idx, 1);
        }
        await interaction.update({ embeds: [generarEmbedModo(modo)], components: [obtenerBotonesModo(modo)] });
        return;
    }

    if (customId.startsWith('fila_')) {
        const partes = customId.split('_');
        const modo = partes[1];
        const numFila = partes[2];

        if (estadoFilas[modo][numFila].includes(userId)) {
            return interaction.reply({ content: '⚠️ Ya estás anotado en esta fila.', ephemeral: true });
        }

        for (const n in estadoFilas[modo]) {
            const idx = estadoFilas[modo][n].indexOf(userId);
            if (idx !== -1) estadoFilas[modo][n].splice(idx, 1);
        }

        estadoFilas[modo][numFila].push(userId);

        if (estadoFilas[modo][numFila].length >= 2) {
            const jugadoresPartida = [...estadoFilas[modo][numFila]];
            estadoFilas[modo][numFila] = [];
            await interaction.update({ embeds: [generarEmbedModo(modo)], components: [obtenerBotonesModo(modo)] });
            await crearSalaDePartida(jugadoresPartida, modo, guild);
            return;
        }

        await interaction.update({ embeds: [generarEmbedModo(modo)], components: [obtenerBotonesModo(modo)] });
    }
});

// COMANDOS DE CHAT
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // ==========================================
    // COMANDOS DE ADMINISTRACIÓN Y CONSULTAS
    // ==========================================

    if (command === '.addcoins' || command === '!addcoins' || command === '.add-coins' || command === '!add-coins') {
        if (!esStaff(message.member)) return message.channel.send('❌ No tienes permisos de Staff para usar este comando.');
        const objetivo = message.mentions.users.first();
        const cantidad = parseInt(args[2] || args[1]);

        if (!objetivo || isNaN(cantidad) || cantidad <= 0) {
            return message.channel.send('⚠️ **Uso correcto:** `.addcoins @jugador <cantidad>`');
        }

        const pData = await obtenerOIniciarUsuario(objetivo.id);
        pData.coins = (pData.coins || 0) + cantidad;
        await pData.save();

        return message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('✅ Coins Agregadas')
                    .setDescription(`Se han añadido **+${cantidad} Coins** a <@${objetivo.id}>.\n🪙 **Nuevo Balance:** \`${pData.coins}\` Coins.`)
                    .setColor('#2ECC71')
            ]
        });
    }

    if (command === '.removecoins' || command === '!removecoins') {
        if (!esStaff(message.member)) return message.channel.send('❌ No tienes permisos de Staff.');
        const objetivo = message.mentions.users.first();
        const cantidad = parseInt(args[2] || args[1]);

        if (!objetivo || isNaN(cantidad) || cantidad <= 0) {
            return message.channel.send('⚠️ **Uso correcto:** `.removecoins @jugador <cantidad>`');
        }

        const pData = await obtenerOIniciarUsuario(objetivo.id);
        pData.coins = Math.max(0, (pData.coins || 0) - cantidad);
        await pData.save();

        return message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('🔻 Coins Retiradas')
                    .setDescription(`Se han retirado **-${cantidad} Coins** a <@${objetivo.id}>.\n🪙 **Nuevo Balance:** \`${pData.coins}\` Coins.`)
                    .setColor('#E74C3C')
            ]
        });
    }

    if (command === '!coins' || command === '.coins') {
        const objetivo = message.mentions.users.first() || message.author;
        const pData = await obtenerOIniciarUsuario(objetivo.id);
        return message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`💰 Balance de Coins`)
                    .setDescription(`👤 **Usuario:** <@${objetivo.id}>\n🪙 **Coins:** \`${pData.coins || 0}\``)
                    .setColor('#F1C40F')
            ]
        });
    }

    if (command === '!stats' || command === '.stats' || command === '!perfil' || command === '.perfil') {
        const objetivo = message.mentions.users.first() || message.author;
        const pData = await obtenerOIniciarUsuario(objetivo.id);
        const totalJugadas = pData.jugadas || 0;
        const victorias = pData.ganadas || 0;
        const derrotas = totalJugadas - victorias;
        const winrate = totalJugadas > 0 ? ((victorias / totalJugadas) * 100).toFixed(1) : '0.0';

        return message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`📊 Estadísticas de ${objetivo.username}`)
                    .setDescription(`👤 **Jugador:** <@${objetivo.id}>\n🪙 **Coins:** \`${pData.coins || 0}\`\n\n🎮 **Partidas Jugadas:** \`${totalJugadas}\`\n🏆 **Victorias:** \`${victorias}\`\n💀 **Derrotas:** \`${derrotas < 0 ? 0 : derrotas}\`\n📈 **Winrate:** \`${winrate}%\``)
                    .setColor('#3498DB')
            ]
        });
    }

    if (command === '!historial' || command === '.historial') {
        const objetivo = message.mentions.users.first() || message.author;
        const pData = await obtenerOIniciarUsuario(objetivo.id);

        if (!pData.historial || pData.historial.length === 0) {
            return message.channel.send(`📋 <@${objetivo.id}> no tiene partidas registradas.`);
        }

        const ultimasPartidas = pData.historial.slice(-5).reverse().map((h, i) => {
            const resEmoji = h.resultado === 'Victoria' ? '🏆' : '❌';
            return `**${i + 1}.** ${resEmoji} **${h.resultado}** | Modo: \`${h.modo || 'N/A'}\` | Coins: \`+${h.coinsObtenidas || 0}\``;
        }).join('\n');

        return message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`📜 Historial Reciente de ${objetivo.username}`)
                    .setDescription(ultimasPartidas)
                    .setColor('#9B59B6')
            ]
        });
    }

    if (command === '.panel-filas' || command === '.setup-filas') {
        if (!esStaff(message.member)) return message.channel.send('❌ Solo el Staff puede enviar el panel.');
        message.delete().catch(() => {});

        for (const modo of MODOS) {
            await message.channel.send({
                embeds: [generarEmbedModo(modo)],
                components: [obtenerBotonesModo(modo)]
            });
        }
        return;
    }

    // ==========================================
    // COMANDOS DENTRO DE SALA (RESTRINGIDOS A CAPITANES)
    // ==========================================

    if (!message.channel.name.startsWith('🎮-partida-')) return;
    const infoPartida = partidasActivas.get(message.channel.id);
    if (!infoPartida) return;

    // COMANDO .team (DESHABILITADO EN 1v1)
    if (command === '.team') {
        if (!esCapitan(message.member)) return message.channel.send('❌ Solo un **Capitán** de esta partida puede usar este comando.');
        if (infoPartida.modo === '1v1') return message.channel.send('❌ El comando `.team` está deshabilitado en partidas 1v1.');
        if (infoPartida.iniciada) return message.channel.send('❌ La partida ya ha comenzado.');

        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ No eres capitán asignado en esta sala.');

        const compañero = message.mentions.users.first();
        if (!compañero || compañero.bot) return message.channel.send('⚠️ **Uso correcto:** `.team @usuario`');

        const equipoDelCapitan = esCap1 ? infoPartida.equipo1 : infoPartida.equipo2;

        if (equipoDelCapitan.length >= infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Tu equipo ya alcanzó el cupo máximo de **${infoPartida.capacidadPorEquipo}** jugadores en Discord.`);
        }

        if (infoPartida.equipo1.includes(compañero.id) || infoPartida.equipo2.includes(compañero.id)) {
            return message.channel.send('❌ El usuario ya está en la partida.');
        }

        if (esCap1) infoPartida.invitacionesPendientesCap1++;
        if (esCap2) infoPartida.invitacionesPendientesCap2++;

        const rowTeam = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('aceptar_equipo').setLabel('Aceptar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('rechazar_equipo').setLabel('Rechazar').setStyle(ButtonStyle.Danger)
        );

        await message.channel.permissionOverwrites.edit(compañero.id, { ViewChannel: true, SendMessages: true });

        const embedInvitacion = new EmbedBuilder()
            .setTitle('📩 INVITACIÓN DE EQUIPO')
            .setDescription(`Hola <@${compañero.id}>, el Capitán <@${message.author.id}> te invita a unirte a su equipo en **${infoPartida.modo.toUpperCase()}**.\n\n👇 Presiona **Aceptar** o **Rechazar**.`)
            .setColor('#F39C12');

        const msgInvitacion = await message.channel.send({ content: `<@${compañero.id}>`, embeds: [embedInvitacion], components: [rowTeam] });

        const collector = msgInvitacion.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== compañero.id) return i.reply({ content: '❌ Solo el invitado puede responder.', ephemeral: true });

            if (i.customId === 'aceptar_equipo') {
                equipoDelCapitan.push(compañero.id);
                if (esCap1) infoPartida.invitacionesPendientesCap1--;
                if (esCap2) infoPartida.invitacionesPendientesCap2--;

                await i.update({ content: `✅ <@${compañero.id}> **ACEPTÓ** unirse al equipo de <@${message.author.id}>.`, embeds: [], components: [] });
                return collector.stop();
            }

            if (i.customId === 'rechazar_equipo') {
                if (esCap1) infoPartida.invitacionesPendientesCap1--;
                if (esCap2) infoPartida.invitacionesPendientesCap2--;

                await message.channel.permissionOverwrites.delete(compañero.id).catch(() => {});
                await i.update({ content: `❌ <@${compañero.id}> **RECHAZÓ** la invitación.`, embeds: [], components: [] });
                return collector.stop();
            }
        });
        return;
    }

    // COMANDO .comenzar
    if (command === '.comenzar') {
        await procesarComenzar(message.channel, message.author, message.guild);
        return;
    }

    // COMANDO .cancelar
    if (command === '.cancelar') {
        await procesarSolicitudCancelar(message.channel, message.author, message.guild);
        return;
    }

    // COMANDO .win CON OPCIÓN DE RETRACTARSE
    if (command === '.win' || command === '.ganador') {
        if (!esCapitan(message.member) && !esStaff(message.member)) {
            return message.channel.send('❌ Solo un **Capitán** o el Staff pueden reclamar la victoria.');
        }

        const usuarioMencionado = message.mentions.users.first();
        if (!usuarioMencionado) {
            return message.channel.send('⚠️ **Uso correcto:** `.win @jugador` (Etiquétate a ti mismo para reclamar la victoria).');
        }

        const numGanador = (usuarioMencionado.id === infoPartida.capitan1 || infoPartida.equipo1.includes(usuarioMencionado.id)) ? 1 : 2;
        const equipoGanador = numGanador === 1 ? infoPartida.equipo1 : infoPartida.equipo2;
        const equipoPerdedor = numGanador === 1 ? infoPartida.equipo2 : infoPartida.equipo1;

        const rowWin = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirmar_win').setLabel('Sí (Confirmar)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('denegar_win').setLabel('No (Disputar)').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('retractar_win').setLabel('↩ Retractarse (Cancelar reclamo)').setStyle(ButtonStyle.Secondary)
        );

        const embedWinMsg = new EmbedBuilder()
            .setTitle('🏆 RECLAMO DE VICTORIA')
            .setDescription(
                `El Capitán <@${message.author.id}> ha reclamado la victoria para el **Equipo ${numGanador}** (<@${usuarioMencionado.id}>).\n\n` +
                `❓ **¿Confirmar resultado y entregar 2 Coins a cada integrante?**`
            )
            .setColor('#F1C40F');

        const msgWin = await message.channel.send({ embeds: [embedWinMsg], components: [rowWin] });

        const collectorWin = msgWin.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collectorWin.on('collect', async i => {
            // Opción para retractarse
            if (i.customId === 'retractar_win') {
                if (i.user.id !== message.author.id && !esStaff(i.member)) {
                    return i.reply({ content: '❌ Solo el usuario que ejecutó el .win puede retractarse.', ephemeral: true });
                }
                await i.update({
                    content: `↩ <@${i.user.id}> se ha **retractado** de su reclamo de victoria. La partida puede continuar.`,
                    embeds: [],
                    components: []
                });
                return collectorWin.stop();
            }

            if (i.customId === 'confirmar_win') {
                if (!esStaff(i.member) && !equipoPerdedor.includes(i.user.id)) {
                    return i.reply({ content: '❌ Solo el equipo rival o el Staff pueden confirmar la victoria.', ephemeral: true });
                }

                // Sumar 2 Coins e historial a ganadores
                for (const uId of equipoGanador) {
                    const pData = await obtenerOIniciarUsuario(uId);
                    pData.coins = (pData.coins || 0) + 2;
                    pData.ganadas = (pData.ganadas || 0) + 1;
                    pData.jugadas = (pData.jugadas || 0) + 1;
                    pData.historial.push({
                        resultado: 'Victoria',
                        modo: infoPartida.modo,
                        coinsObtenidas: 2,
                        fecha: new Date()
                    });
                    await pData.save();
                }

                // Registrar derrotas
                for (const uId of equipoPerdedor) {
                    const pData = await obtenerOIniciarUsuario(uId);
                    pData.jugadas = (pData.jugadas || 0) + 1;
                    pData.historial.push({
                        resultado: 'Derrota',
                        modo: infoPartida.modo,
                        coinsObtenidas: 0,
                        fecha: new Date()
                    });
                    await pData.save();
                }

                await quitarRolCapitan(message.guild, infoPartida.capitan1);
                await quitarRolCapitan(message.guild, infoPartida.capitan2);
                partidasActivas.delete(message.channel.id);

                await i.update({
                    content: `🏆 **¡Victoria confirmada!** Se otorgaron **2 Coins** a cada integrante del Equipo ${numGanador}.\n🔒 *Cerrando canal en 5 segundos...*`,
                    embeds: [],
                    components: []
                });

                collectorWin.stop();
                setTimeout(() => message.channel.delete().catch(() => {}), 5000);

            } else if (i.customId === 'denegar_win') {
                await i.update({
                    content: `🚨 **DISPUTA DE PARTIDA**\n<@${i.user.id}> ha rechazado la victoria reclamada.\n📢 **Atención Staff:** ${ROLES_STAFF.map(r => `@${r}`).join(' ')}`,
                    embeds: [],
                    components: []
                });
                collectorWin.stop();
            }
        });
        return;
    }
});

// Servidor HTTP para Render
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot 1 en linea 24/7');
}).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
