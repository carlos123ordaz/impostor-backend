const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const Room = require('./models/Room');
const { getRandomWord, generateRoomCode, selectImpostors } = require('./utils/gameHelpers');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
         origin: [
          "http://localhost:5173",
          "http://localhost:3000",
          "https://www.impostor.lat",
          "https://impostor.lat"
        ],
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Conectar a MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/impostor-game';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB conectado'))
    .catch(err => console.error('❌ Error MongoDB:', err));

// Mapa para reconexiones: playerId -> {roomCode, playerName}
const playerSessions = new Map();

// Socket.IO eventos
io.on('connection', (socket) => {
    console.log('🔌 Usuario conectado:', socket.id);

    // Crear nueva sala
    socket.on('create-room', async (data, callback) => {
        try {
            const roomCode = generateRoomCode();
            const room = new Room({
                roomCode,
                adminId: socket.id,
                players: [{
                    id: socket.id,
                    name: data.playerName,
                    isAdmin: true
                }],
                settings: {
                    impostorCount: 1,
                    category: 'all',
                    impostorCanSeeHint: false
                }
            });

            await room.save();
            socket.join(roomCode);

            // Guardar sesión
            playerSessions.set(socket.id, {
                roomCode,
                playerName: data.playerName
            });

            callback({ success: true, roomCode });
            io.to(roomCode).emit('room-update', room);
        } catch (error) {
            console.error('Error creando sala:', error);
            callback({ success: false, error: error.message });
        }
    });

    // Unirse a sala
    socket.on('join-room', async (data, callback) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode.toUpperCase() });

            if (!room) {
                return callback({ success: false, error: 'Sala no encontrada' });
            }

            if (room.gameState !== 'waiting') {
                return callback({ success: false, error: 'El juego ya comenzó' });
            }

            const existingPlayer = room.players.find(p => p.name === data.playerName);
            if (existingPlayer) {
                return callback({ success: false, error: 'Nombre ya en uso' });
            }

            room.players.push({
                id: socket.id,
                name: data.playerName,
                isAdmin: false
            });

            await room.save();
            socket.join(data.roomCode.toUpperCase());

            // Guardar sesión
            playerSessions.set(socket.id, {
                roomCode: data.roomCode.toUpperCase(),
                playerName: data.playerName
            });

            callback({ success: true, isAdmin: false });
            io.to(data.roomCode.toUpperCase()).emit('room-update', room);
        } catch (error) {
            console.error('Error uniéndose a sala:', error);
            callback({ success: false, error: error.message });
        }
    });

    // Reconectar a sala existente
    socket.on('reconnect-to-room', async (data, callback) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode.toUpperCase() });

            if (!room) {
                return callback({ success: false, error: 'Sala no encontrada' });
            }

            // Buscar al jugador por nombre
            const playerIndex = room.players.findIndex(p => p.name === data.playerName);

            if (playerIndex === -1) {
                return callback({ success: false, error: 'Jugador no encontrado en esta sala' });
            }

            // Actualizar el ID del socket del jugador
            const oldId = room.players[playerIndex].id;
            room.players[playerIndex].id = socket.id;

            // Si era admin, actualizar adminId
            if (room.adminId === oldId) {
                room.adminId = socket.id;
            }

            // IMPORTANTE: Actualizar el turnOrder con el nuevo socket ID
            if (room.turnOrder && room.turnOrder.length > 0) {
                const turnIndex = room.turnOrder.indexOf(oldId);
                if (turnIndex !== -1) {
                    room.turnOrder[turnIndex] = socket.id;
                    console.log(`🔄 TurnOrder actualizado en posición ${turnIndex}: ${oldId} -> ${socket.id}`);
                    console.log(`📊 TurnOrder completo:`, room.turnOrder);
                } else {
                    console.log(`⚠️ OldId ${oldId} no encontrado en turnOrder:`, room.turnOrder);
                }
            } else {
                console.log('⚠️ No hay turnOrder para actualizar');
            }

            await room.save();
            socket.join(data.roomCode.toUpperCase());

            // Actualizar sesión
            playerSessions.set(socket.id, {
                roomCode: data.roomCode.toUpperCase(),
                playerName: data.playerName
            });

            const player = room.players[playerIndex];

            callback({
                success: true,
                isAdmin: player.isAdmin,
                gameState: room.gameState,
                role: player.isImpostor !== undefined ? {
                    isImpostor: player.isImpostor,
                    word: player.isImpostor ? null : room.currentWord,
                    hint: player.isImpostor
                        ? (room.settings.impostorCanSeeHint ? room.currentHint : null)
                        : null
                } : null,
                turnOrder: room.turnOrder || [],
                currentTurnIndex: room.currentTurnIndex || 0
            });

            // Enviar room-update inmediatamente para sincronizar datos
            io.to(data.roomCode.toUpperCase()).emit('room-update', room);

            io.to(data.roomCode.toUpperCase()).emit('room-update', room);
            console.log('✅ Jugador reconectado:', data.playerName);
        } catch (error) {
            console.error('Error reconectando:', error);
            callback({ success: false, error: error.message });
        }
    });

    // Actualizar configuración de la sala
    socket.on('update-settings', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.settings.impostorCount = data.settings.impostorCount;
            room.settings.category = data.settings.category || 'all';
            room.settings.impostorCanSeeHint = data.settings.impostorCanSeeHint !== undefined
                ? data.settings.impostorCanSeeHint
                : false;

            await room.save();

            console.log('⚙️ Configuración actualizada:', {
                roomCode: room.roomCode,
                settings: room.settings
            });

            io.to(data.roomCode).emit('room-update', room);
        } catch (error) {
            console.error('Error actualizando configuración:', error);
        }
    });

    // Iniciar juego
    socket.on('start-game', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;
            if (room.players.length < 3) {
                socket.emit('error', { message: 'Se necesitan al menos 3 jugadores' });
                return;
            }

            // Seleccionar impostores
            const impostorIds = selectImpostors(room.players, room.settings.impostorCount);

            // Obtener palabra y pista según la categoría configurada
            const { word, hint } = getRandomWord(room.settings.category);

            console.log('🎮 Juego iniciado:', {
                roomCode: room.roomCode,
                word,
                hint,
                category: room.settings.category,
                impostorCanSeeHint: room.settings.impostorCanSeeHint
            });

            room.players.forEach(player => {
                player.isImpostor = impostorIds.includes(player.id);
            });

            room.gameState = 'started';
            room.currentWord = word;
            room.currentHint = hint;
            room.isPaused = false;

            // Crear orden de turnos aleatorio
            const turnOrder = [...room.players].sort(() => Math.random() - 0.5);
            room.turnOrder = turnOrder.map(p => p.id);
            room.currentTurnIndex = 0;

            await room.save();

            // Enviar roles individuales a cada jugador
            room.players.forEach(player => {
                io.to(player.id).emit('role-assigned', {
                    isImpostor: player.isImpostor,
                    word: player.isImpostor ? null : word,
                    hint: player.isImpostor
                        ? (room.settings.impostorCanSeeHint ? hint : null)
                        : null
                });
            });

            io.to(data.roomCode).emit('game-started', {
                players: room.players,
                turnOrder: room.turnOrder,
                currentTurnIndex: room.currentTurnIndex
            });
        } catch (error) {
            console.error('Error iniciando juego:', error);
        }
    });

    // Pasar al siguiente turno
    socket.on('next-turn', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.gameState !== 'started') return;

            // Mover el primer jugador al final
            if (room.turnOrder && room.turnOrder.length > 0) {
                const currentPlayer = room.turnOrder.shift();
                room.turnOrder.push(currentPlayer);
                
                await room.save();
                
                io.to(data.roomCode).emit('turn-updated', {
                    turnOrder: room.turnOrder,
                    currentPlayerName: room.players.find(p => p.id === room.turnOrder[0])?.name
                });
            }
        } catch (error) {
            console.error('Error pasando turno:', error);
        }
    });

    // Iniciar votación
    socket.on('start-voting', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.gameState = 'voting';
            room.isPaused = false;

            room.players.forEach(player => {
                player.hasVoted = false;
                player.votedFor = null;
            });

            await room.save();
            io.to(data.roomCode).emit('voting-started', room);
        } catch (error) {
            console.error('Error iniciando votación:', error);
        }
    });

    // Votar
    socket.on('vote', async (data) => {
        try {
            console.log('📥 Voto recibido:', { playerId: socket.id, roomCode: data.roomCode, votedFor: data.votedPlayerId });

            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.gameState !== 'voting') {
                console.log('❌ Sala no encontrada o no está en votación');
                return;
            }

            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex === -1) {
                console.log('❌ Jugador no encontrado en la sala');
                return;
            }

            const player = room.players[playerIndex];
            if (player.hasVoted) {
                console.log('⚠️ Jugador ya votó');
                return;
            }

            room.players[playerIndex].hasVoted = true;
            room.players[playerIndex].votedFor = data.votedPlayerId;
            room.markModified('players');

            await room.save();

            const verifyRoom = await Room.findOne({ roomCode: data.roomCode });
            const verifyPlayer = verifyRoom.players.find(p => p.id === socket.id);

            console.log('✅ Voto guardado. Estado actual:', {
                playerName: player.name,
                hasVoted: room.players[playerIndex].hasVoted,
                votedFor: room.players[playerIndex].votedFor,
                totalVoted: room.players.filter(p => p.hasVoted).length,
                totalPlayers: room.players.length
            });

            io.to(data.roomCode).emit('room-update', verifyRoom);

            const allVoted = verifyRoom.players.every(p => p.hasVoted);

            if (allVoted) {
                const voteCounts = {};
                verifyRoom.players.forEach(p => {
                    if (p.votedFor) {
                        voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
                    }
                });

                let maxVotes = 0;
                Object.values(voteCounts).forEach(votes => {
                    if (votes > maxVotes) maxVotes = votes;
                });

                const tiedPlayers = Object.entries(voteCounts)
                    .filter(([playerId, votes]) => votes === maxVotes)
                    .map(([playerId]) => playerId);

                console.log('📊 Resultado de votación:', {
                    voteCounts,
                    maxVotes,
                    tiedPlayers,
                    hayEmpate: tiedPlayers.length > 1
                });

                if (tiedPlayers.length > 1) {
                    console.log('⚖️ EMPATE DETECTADO - Nueva ronda de votación');

                    verifyRoom.players.forEach(player => {
                        player.hasVoted = false;
                        player.votedFor = null;
                    });

                    verifyRoom.gameState = 'voting';
                    await verifyRoom.save();

                    io.to(data.roomCode).emit('voting-tie', {
                        tiedPlayers: tiedPlayers.map(id => {
                            const player = verifyRoom.players.find(p => p.id === id);
                            return {
                                id: player.id,
                                name: player.name
                            };
                        }),
                        voteCounts
                    });

                    io.to(data.roomCode).emit('room-update', verifyRoom);

                    return;
                }

                const votedOutPlayerId = tiedPlayers[0];
                const votedOutPlayer = verifyRoom.players.find(p => p.id === votedOutPlayerId);
                const impostorFound = votedOutPlayer?.isImpostor || false;

                console.log('🎯 Jugador eliminado:', {
                    name: votedOutPlayer?.name,
                    isImpostor: impostorFound
                });

                verifyRoom.gameState = 'ended';
                await verifyRoom.save();

                io.to(data.roomCode).emit('game-ended', {
                    impostorFound,
                    votedOutPlayer: votedOutPlayer ? {
                        name: votedOutPlayer.name,
                        isImpostor: votedOutPlayer.isImpostor
                    } : null,
                    impostors: verifyRoom.players.filter(p => p.isImpostor).map(p => p.name),
                    word: verifyRoom.currentWord,
                    voteCounts
                });
            } else {
                io.to(data.roomCode).emit('vote-update', {
                    votedCount: verifyRoom.players.filter(p => p.hasVoted).length,
                    totalPlayers: verifyRoom.players.length
                });
            }
        } catch (error) {
            console.error('Error votando:', error);
        }
    });

    // Salir del juego intencionalmente
    socket.on('leave-game', async (data) => {
        try {
            console.log('🚪 Usuario saliendo intencionalmente:', socket.id);
            
            // Limpiar sesión
            playerSessions.delete(socket.id);
            
            const room = await Room.findOne({ roomCode: data.roomCode });
            if (!room) return;

            // Eliminar jugador inmediatamente
            const playerName = room.players.find(p => p.id === socket.id)?.name;
            room.players = room.players.filter(p => p.id !== socket.id);

            // Actualizar turnOrder si existe
            if (room.turnOrder && room.turnOrder.length > 0) {
                room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
            }

            if (room.players.length === 0) {
                // Si no quedan jugadores, eliminar sala
                await Room.deleteOne({ _id: room._id });
                console.log('🗑️ Sala eliminada (sin jugadores):', room.roomCode);
            } else {
                // Si el admin se fue, asignar nuevo admin
                if (room.adminId === socket.id && room.players.length > 0) {
                    room.adminId = room.players[0].id;
                    room.players[0].isAdmin = true;
                    console.log('👑 Nuevo admin asignado:', room.players[0].name);
                }

                await room.save();
                
                // Notificar a los demás
                io.to(data.roomCode).emit('player-left', {
                    playerName,
                    playerId: socket.id
                });
                
                io.to(data.roomCode).emit('room-update', room);
                console.log('✅ Jugador eliminado de la sala:', playerName);
            }

            socket.leave(data.roomCode);
        } catch (error) {
            console.error('Error en leave-game:', error);
        }
    });

    // Reiniciar juego
    socket.on('restart-game', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.gameState = 'waiting';
            room.currentWord = null;
            room.currentHint = null;
            room.isPaused = false;
            room.turnOrder = [];
            room.currentTurnIndex = 0;

            room.players.forEach(player => {
                player.isImpostor = false;
                player.hasVoted = false;
                player.votedFor = null;
                player.isAlive = true;
            });

            await room.save();
            io.to(data.roomCode).emit('room-update', room);
        } catch (error) {
            console.error('Error reiniciando juego:', error);
        }
    });

    // Desconexión
    socket.on('disconnect', async () => {
        console.log('🔌 Usuario desconectado:', socket.id);

        try {
            const session = playerSessions.get(socket.id);
            
            // Si la sesión ya fue eliminada (por leave-game), no hacer nada más
            if (!session) {
                console.log('ℹ️ Sesión ya limpiada (salida intencional)');
                return;
            }

            if (session) {
                console.log('📝 Sesión guardada para reconexión:', session);
                // No eliminar inmediatamente, dar tiempo para reconectar
                setTimeout(() => {
                    if (playerSessions.has(socket.id)) {
                        playerSessions.delete(socket.id);
                        console.log('🗑️ Sesión expirada:', socket.id);
                    }
                }, 300000); // 5 minutos para reconectar
            }

            const rooms = await Room.find({ 'players.id': socket.id });

            for (const room of rooms) {
                // Notificar desconexión temporal (no salida)
                io.to(room.roomCode).emit('player-disconnected', {
                    playerId: socket.id,
                    playerName: room.players.find(p => p.id === socket.id)?.name
                });

                // Esperar 30 segundos antes de eliminar definitivamente
                setTimeout(async () => {
                    const currentRoom = await Room.findOne({ roomCode: room.roomCode });
                    if (!currentRoom) return;

                    // Verificar si el jugador sigue desconectado
                    const playerStillDisconnected = !currentRoom.players.find(p => 
                        p.id === socket.id && io.sockets.sockets.has(socket.id)
                    );

                    if (playerStillDisconnected) {
                        // Verificar si todavía tiene sesión (si no, ya fue eliminado por leave-game)
                        if (!playerSessions.has(socket.id)) {
                            console.log('ℹ️ Jugador ya eliminado por salida intencional');
                            return;
                        }

                        currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);

                        // Actualizar turnOrder
                        if (currentRoom.turnOrder && currentRoom.turnOrder.length > 0) {
                            currentRoom.turnOrder = currentRoom.turnOrder.filter(id => id !== socket.id);
                        }

                        if (currentRoom.players.length === 0) {
                            await Room.deleteOne({ _id: currentRoom._id });
                        } else {
                            if (currentRoom.adminId === socket.id && currentRoom.players.length > 0) {
                                currentRoom.adminId = currentRoom.players[0].id;
                                currentRoom.players[0].isAdmin = true;
                            }

                            await currentRoom.save();
                            io.to(currentRoom.roomCode).emit('room-update', currentRoom);
                        }
                    }
                }, 30000); // 30 segundos
            }
        } catch (error) {
            console.error('Error en desconexión:', error);
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
