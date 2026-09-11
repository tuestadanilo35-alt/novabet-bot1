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

// ROLES Y CONFIGURACIÓN
const ROLES_STAFF = ['ADMINS | NOVA BET', 'OWNERS | NOVA BET', 'ADM | FILA'];
const CATEGORIA_FILAS_ID = 'AQUÍ_ID_CATEGORIA_PARTIDAS';

// Configuración de las modalidades (1v1 a 6v6)
const MODALIDADES = {
    '1v1': 1,
    '2v2': 2,
    '3v3': 3,
    '4v4': 4,
    '5v5': 5,
    '6v6': 6
};

const filas = {
    '1v1': [],
    '2v2': [],
    '3v3': [],
    '4v4': [],
    '5v5': [],
    '6v6': []
};

const partidasActivas = new Map();

// Conexión a MongoDB Atlas
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

client.once('ready', () => console.log(`🤖 Bot 1 (Filas y Modalidades) conectado como ${client.user.tag}`));

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // ==========================================
    // SISTEMA DE FILAS DE HABILIDADES (.1v1, .2v2, ..., .6v6)
    // ==========================================

    if (MODALIDADES[command.substring(1)]) {
        const modo = command.substring(1);
        const pData = await obtenerOIniciarUsuario(message.author.id);

        if (pData.bloqueadoFilas) {
            return message.channel.send(`🚫 <@${message.author.id}>, estás bloqueado de las filas por acumular 3 sanciones.`);
        }

        const capacidadPorEquipo = MODALIDADES[modo];
        const filaActual = filas[modo];

        if (filaActual.includes(message.author.id)) {
            return message.channel.send(`⚠️ Ya estás anotado en la fila de **${modo.toUpperCase()}**.`);
        }

        filaActual.push(message.author.id);
        message.channel.send(`✅ <@${message.author.id}> se unió a la fila **${modo.toUpperCase()}** (${filaActual.length}/${capacidadPorEquipo * 2}).`);

        // Crear la partida cuando se completa la fila
        if (filaActual.length === capacidadPorEquipo * 2) {
            const capitanes = [...filaActual];
            filas[modo] = []; // Reiniciar la fila

            const cap1 = capitanes[0];
            const cap2 = capitanes[1];

            const guild = message.guild;
            const overwrites = [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: cap1, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: cap2, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ];

            guild.roles.cache.forEach(r => {
                if (ROLES_STAFF.includes(r.name)) {
                    overwrites.push({ id: r.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
                }
            });

            const ch = await guild.channels.create({
                name: `🎮-partida-${modo}-${message.author.username}`,
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
                    (capacidadPorEquipo > 1 ? `1️⃣ **.team @jugador**: Invita a un compañero a tu equipo (Solo capitanes).\n` : '') +
                    `2️⃣ **.comenzar**: Ambos capitanes ejecutan para iniciar.\n` +
                    `3️⃣ **.win**: El capitán ganador reclama la victoria al finalizar.`)
                .setColor('#3498DB');

            await ch.send({ content: `<@${cap1}> <@${cap2}>`, embeds: [embedInstrucciones] });
        }
        return;
    }

    // COMANDO PARA SALIR DE LA FILA (.salir)
    if (command === '.salir') {
        let salio = false;
        for (const modo in filas) {
            const idx = filas[modo].indexOf(message.author.id);
            if (idx !== -1) {
                filas[modo].splice(idx, 1);
                salio = true;
                message.channel.send(`🚪 <@${message.author.id}> salió de la fila de **${modo.toUpperCase()}**.`);
            }
        }
        if (!salio) message.channel.send('❌ No estás en ninguna fila activa.');
        return;
    }

    // ==========================================
    // ACCIONES DENTRO DEL CANAL DE LA PARTIDA
    // ==========================================

    if (!message.channel.name.startsWith('🎮-partida-')) return;
    const infoPartida = partidasActivas.get(message.channel.id);
    if (!infoPartida) return;

    // COMANDO .team (INVITACIÓN EN EL MISMO CANAL)
    if (command === '.team') {
        if (infoPartida.iniciada) return message.channel.send('❌ La partida ya ha comenzado.');

        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) {
            return message.channel.send('❌ Solo los capitanes del equipo pueden invitar integrantes.');
        }

        const compañero = message.mentions.users.first();
        if (!compañero || compañero.bot) return message.channel.send('❌ Etiqueta a un jugador válido. Uso: `.team @usuario`');

        const equipoDelCapitan = esCap1 ? infoPartida.equipo1 : infoPartida.equipo2;

        if (equipoDelCapitan.length >= infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Tu equipo ya está completo (${infoPartida.capacidadPorEquipo}/${infoPartida.capacidadPorEquipo}).`);
        }

        if (infoPartida.equipo1.includes(compañero.id) || infoPartida.equipo2.includes(compañero.id)) {
            return message.channel.send('❌ El usuario ya forma parte de esta partida.');
        }

        const rowTeam = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('aceptar_equipo').setLabel('Aceptar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('rechazar_equipo').setLabel('Rechazar').setStyle(ButtonStyle.Danger)
        );

        // Dar permisos inmediatos para ver y escribir en la sala de la partida
        await message.channel.permissionOverwrites.edit(compañero.id, { ViewChannel: true, SendMessages: true });

        const embedInvitacion = new EmbedBuilder()
            .setTitle('📩 INVITACIÓN A EQUIPO')
            .setDescription(`Hola <@${compañero.id}>, ¿quieres formar parte de este equipo con <@${message.author.id}> para jugar **${infoPartida.modo.toUpperCase()}**?`)
            .setColor('#F39C12');

        const msgInvitacion = await message.channel.send({ content: `<@${compañero.id}>`, embeds: [embedInvitacion], components: [rowTeam] });

        const collector = msgInvitacion.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== compañero.id) {
                return i.reply({ content: '❌ Solo el jugador etiquetado puede responder a esta invitación.', ephemeral: true });
            }

            if (i.customId === 'aceptar_equipo') {
                equipoDelCapitan.push(compañero.id);
                await i.update({ content: `✅ <@${compañero.id}> ha aceptado formar parte del equipo.`, embeds: [], components: [] });
                return collector.stop();
            }

            if (i.customId === 'rechazar_equipo') {
                // Quitar permiso del canal si rechaza
                await message.channel.permissionOverwrites.delete(compañero.id).catch(() => {});
                await i.update({ content: `❌ <@${compañero.id}> rechazó la invitación al equipo.`, embeds: [], components: [] });
                return collector.stop();
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                msgInvitacion.edit({ content: '⏰ Invitación expirada.', embeds: [], components: [] }).catch(() => {});
            }
        });
        return;
    }

    // COMANDO .comenzar (SOLO CAPITANES)
    if (command === '.comenzar') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2) return message.channel.send('❌ Solo los capitanes pueden dar inicio.');

        if (infoPartida.equipo1.length < infoPartida.capacidadPorEquipo || infoPartida.equipo2.length < infoPartida.capacidadPorEquipo) {
            return message.channel.send(`❌ Faltan integrantes en los equipos para completar la modalidad **${infoPartida.modo.toUpperCase()}**.`);
        }

        infoPartida.iniciada = true;
        return message.channel.send('🚀 **¡La partida ha comenzado oficialmente!** Buena suerte a ambos equipos.');
    }

    // COMANDO .win (2 COINS PARA CAPITÁN E INTEGRANTES)
    if (command === '.win' || command === '.ganador') {
        const esCap1 = message.author.id === infoPartida.capitan1;
        const esCap2 = message.author.id === infoPartida.capitan2;

        if (!esCap1 && !esCap2 && !esStaff(message.member)) {
            return message.channel.send('❌ Solo el capitán de cada equipo o el Staff pueden reclamar la victoria con `.win`.');
        }

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
                `❓ **¿Confirmar resultado y entregar 2 Coins a cada capitán e integrante?**`)
            .setColor('#2ECC71');

        const msgWin = await message.channel.send({ embeds: [embedWinMsg], components: [rowWin] });

        const collectorWin = msgWin.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collectorWin.on('collect', async i => {
            if (i.customId === 'confirmar_win') {
                if (!esStaff(i.member) && !equipoPerdedor.includes(i.user.id) && i.user.id !== message.author.id) {
                    return i.reply({ content: '❌ No tienes permisos para confirmar esta victoria.', ephemeral: true });
                }

                // Entrega de 2 Coins a TODOS (Capitán + Integrantes)
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

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot 1 en linea 24/7');
}).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
