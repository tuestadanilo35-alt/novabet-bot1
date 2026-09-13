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

// Estructura para almacenar las 3 filas de cada modalidad (1v1 a 6v6)
const MODOS = ['1v1', '2v2', '3v3', '4v4', '5v5', '6v6'];
const estadoFilas = {};

MODOS.forEach(m => {
    estadoFilas[m] = {
        1: [],
        2: [],
        3: []
    };
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
            `🟢 **Fila 1 — ${filasModo[1].length}/2 jugador(es)**\n${renderFila(1)}\n\n` +
            `🟡 **Fila 2 — ${filasModo[2].length}/2 jugador(es)**\n${renderFila(2)}\n\n` +
            `🔵 **Fila 3 — ${filasModo[3].length}/2 jugador(es)**\n${renderFila(3)}`
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

// Crear sala al unirse 2 CAPITANES
async function crearSalaDePartida(jugadores, modo, guild) {
    const cap1 = jugadores[0];
    const cap2 = jugadores[1];
    const numJugadoresPorEquipo = parseInt(modo.replace('v', '')) || 1;

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
        listoCapitan1: false,
        listoCapitan2: false,
        iniciada: false
    });

    const embedInstrucciones = new EmbedBuilder()
        .setTitle(`🎮 PARTIDA DE HABILIDAD: ${modo.toUpperCase()}`)
        .setDescription(
            `🥊 **Capitán 1:** <@${cap1}>\n🥊 **Capitán 2:** <@${cap2}>\n\n` +
            `📌 **INSTRUCCIONES:**\n` +
            (numJugadoresPorEquipo > 1 ? `1️⃣ **.team @jugador**: Invita integrantes a tu equipo (Faltan ${numJugadoresPorEquipo - 1} por equipo).\n` : '') +
            `2️⃣ **.comenzar**: **Ambos capitanes** deben ejecutar este comando para iniciar.\n` +
            `3️⃣ **.win @jugador**: El capitán ganador reclama la victoria etiquetándose a sí mismo al finalizar.`
        )
        .setColor('#3498DB');

    await ch.send({ content: `<@${cap1}> <@${cap2}>`, embeds: [embedInstrucciones] });
}

client.once('ready', () => console.log(`🤖 Bot 1 conectado como ${client.user.tag}`));

// MANEJO DE BOTONES DE FILA (SIEMPRE 2 JUGADORES/CAPITANES)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, user, guild } = interaction;
    const userId = user.id;

    const pData = await obtenerOIniciarUsuario(userId);
    if (pData.bloqueadoFilas) {
        return interaction.reply({ content: '🚫 Estás bloqueado de las filas por acumular sanciones.', ephemeral: true });
    }

    // BOTÓN SALIR
    if (customId.startsWith('salir_')) {
        const modo = customId.replace('salir_', '');
        for (const num in estadoFilas[modo]) {
            const idx = estadoFilas[modo][num].indexOf(userId);
            if (idx !== -1) estadoFilas[modo][num].splice(idx, 1);
        }
        await interaction.update({ embeds: [generarEmbedModo(modo)], components: [obtenerBotonesModo(modo)] });
        return;
    }

    // BOTONES ENTRAR A FILA
    if (customId.startsWith('fila_')) {
        const partes = customId.split('_');
        const modo = partes[1];
        const numFila = partes[2];

        // Evitar que el mismo capitán entre dos veces
        if (estadoFilas[modo][numFila].includes(userId)) {
            return interaction.reply({ content: '⚠️ Ya estás anotado en esta fila.', ephemeral: true });
        }

        // Remover de cualquier otra fila del mismo modo
        for (const n in estadoFilas[modo]) {
            const idx = estadoFilas[modo][n].indexOf(userId);
            if (idx !== -1) estadoFilas[modo][n].splice(idx, 1);
        }

        // Agregar al capitán
        estadoFilas[modo][numFila].push(userId);

        // ¡REGLA CLAVE!: Basta con 2 capitanes en la fila para crear la sala
        if (estadoFilas[modo][numFila].length >= 2) {
            const jugadoresPartida = [...estadoFilas[modo][numFila]];
            estadoFilas[modo][numFila] = []; // Vaciar fila en el panel
            await interaction.update({ embeds: [generarEmbedModo(modo)], components: [obtenerBotonesModo(modo)] });
            await crearSalaDePartida(jugadoresPartida, modo, guild);
            return;
        }

        // Actualizar el Embed visualmente sin enviar mensajes de chat
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

    // COMANDO PARA CREAR TODOS LOS PANELES DE FILAS
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
    // COMANDOS DENTRO DE SALA (.team, .comenzar, .win)
    // ==========================================

    if (!message.channel.name.startsWith('🎮-partida-')) return;
    const infoPartida = partidasActivas.get(message.channel.id);
    if (!infoPartida) return;

    // COMANDO .team
    if (command === '.team') {
        if (infoPartida.iniciada) return message.channel.send('❌ La partida ya ha comenzado.');

        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ Solo los capitanes pueden invitar integrantes a su equipo.');

        const compañero = message.mentions.users.first();
        if (!compañero || compañero.bot) return message.channel.send('❌ Etiqueta a un jugador válido. Uso: `.team @usuario`');

        const equipoDelCapitan = esCap1 ? infoPartida.equipo1 : infoPartida.equipo2;

        if (equipoDelCapitan.length >= infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Tu equipo ya alcanzó el límite máximo de **${infoPartida.capacidadPorEquipo}** jugadores para la modalidad ${infoPartida.modo.toUpperCase()}.`);
        }

        if (infoPartida.equipo1.includes(compañero.id) || infoPartida.equipo2.includes(compañero.id)) {
            return message.channel.send('❌ El usuario ya forma parte de la partida.');
        }

        const rowTeam = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('aceptar_equipo').setLabel('Aceptar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('rechazar_equipo').setLabel('Rechazar').setStyle(ButtonStyle.Danger)
        );

        await message.channel.permissionOverwrites.edit(compañero.id, { ViewChannel: true, SendMessages: true });

        const embedInvitacion = new EmbedBuilder()
            .setTitle('📩 INVITACIÓN DE EQUIPO')
            .setDescription(`Hola <@${compañero.id}>, el capitán <@${message.author.id}> te ha invitado a unirte a su equipo para jugar **${infoPartida.modo.toUpperCase()}**.\n\n👇 Presiona un botón para Aceptar o Rechazar.`)
            .setColor('#F39C12');

        const msgInvitacion = await message.channel.send({ content: `<@${compañero.id}>`, embeds: [embedInvitacion], components: [rowTeam] });

        const collector = msgInvitacion.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== compañero.id) return i.reply({ content: '❌ Solo el jugador invitado puede responder.', ephemeral: true });

            if (i.customId === 'aceptar_equipo') {
                equipoDelCapitan.push(compañero.id);
                await i.update({ content: `✅ <@${compañero.id}> ha **ACEPTADO** unirse al equipo de <@${message.author.id}>.`, embeds: [], components: [] });
                return collector.stop();
            }

            if (i.customId === 'rechazar_equipo') {
                await message.channel.permissionOverwrites.delete(compañero.id).catch(() => {});
                await i.update({ content: `❌ <@${compañero.id}> **RECHAZÓ** la invitación.`, embeds: [], components: [] });
                return collector.stop();
            }
        });
        return;
    }

    // COMANDO .comenzar (REQUIERE QUE AMBOS CAPITANES LO USEN)
    if (command === '.comenzar') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ Solo los 2 capitanes pueden dar inicio.');

        if (infoPartida.equipo1.length < infoPartida.capacidadPorEquipo || infoPartida.equipo2.length < infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Los equipos aún no están completos. Ambos deben tener **${infoPartida.capacidadPorEquipo}** jugador(es).`);
        }

        if (esCap1) infoPartida.listoCapitan1 = true;
        if (esCap2) infoPartida.listoCapitan2 = true;

        if (infoPartida.listoCapitan1 && infoPartida.listoCapitan2) {
            infoPartida.iniciada = true;
            return message.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('🚀 ¡PARTIDA INICIADA!')
                        .setDescription('Ambos capitanes han confirmado. ¡Mucha suerte a ambos equipos!')
                        .setColor('#2ECC71')
                ]
            });
        } else {
            const capFaltante = infoPartida.listoCapitan1 ? infoPartida.capitan2 : infoPartida.capitan1;
            return message.channel.send(`✅ Capitán <@${message.author.id}> listo. Esperando a que el otro capitán (<@${capFaltante}>) ejecute **.comenzar**.`);
        }
    }

    // COMANDO .win (EL GANADOR SE ETIQUETA A SÍ MISMO O A SU EQUIPO)
    if (command === '.win' || command === '.ganador') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2 && !esStaff(message.member)) return message.channel.send('❌ Solo un capitán o el Staff pueden declarar victoria.');

        const usuarioMencionado = message.mentions.users.first();
        if (!usuarioMencionado) {
            return message.channel.send('⚠️ **Uso correcto:** `.win @jugador` (Etiquétate a ti mismo para reclamar victoria).');
        }

        const numGanador = (usuarioMencionado.id === infoPartida.capitan1 || infoPartida.equipo1.includes(usuarioMencionado.id)) ? 1 : 2;
        const equipoGanador = numGanador === 1 ? infoPartida.equipo1 : infoPartida.equipo2;
        const equipoPerdedor = numGanador === 1 ? infoPartida.equipo2 : infoPartida.equipo1;

        const rowWin = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirmar_win').setLabel('Sí (Confirmar Result)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('denegar_win').setLabel('No (Disputar / Staff)').setStyle(ButtonStyle.Danger)
        );

        const embedWinMsg = new EmbedBuilder()
            .setTitle('🏆 RECLAMO DE VICTORIA')
            .setDescription(
                `El capitán <@${message.author.id}> ha reclamado la victoria para el **Equipo ${numGanador}** (<@${usuarioMencionado.id}>).\n\n` +
                `❓ **¿Confirmar resultado y entregar 2 Coins a cada integrante del equipo ganador?**`
            )
            .setColor('#F1C40F');

        const msgWin = await message.channel.send({ embeds: [embedWinMsg], components: [rowWin] });

        const collectorWin = msgWin.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collectorWin.on('collect', async i => {
            if (i.customId === 'confirmar_win') {
                if (!esStaff(i.member) && !equipoPerdedor.includes(i.user.id)) {
                    return i.reply({ content: '❌ Solo el equipo rival o el Staff pueden confirmar la victoria.', ephemeral: true });
                }

                // Otorgar 2 coins al equipo ganador
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

                // Registrar derrota al equipo perdedor
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

// Servidor HTTP para mantener activo Render
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot 1 en linea 24/7');
}).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
