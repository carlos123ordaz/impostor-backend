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
        origin: process.env.CLIENT_URL || "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Conectar a MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB conectado'))
    .catch(err => console.error('❌ Error MongoDB:', err));

// Timers activos para cada sala
const roomTimers = {};

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
                    roundDuration: 120
                }
            });

            await room.save();
            socket.join(roomCode);

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

            callback({ success: true, isAdmin: false });
            io.to(data.roomCode.toUpperCase()).emit('room-update', room);
        } catch (error) {
            console.error('Error uniéndose a sala:', error);
            callback({ success: false, error: error.message });
        }
    });

    // Actualizar configuración de la sala
    socket.on('update-settings', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.settings.impostorCount = data.settings.impostorCount;
            room.settings.roundDuration = data.settings.roundDuration;

            await room.save();
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

            // Obtener palabra y pista
            const { word, hint } = getRandomWord();


            room.players.forEach(player => {
                player.isImpostor = impostorIds.includes(player.id);
            });

            room.gameState = 'started';
            room.currentWord = word;
            room.currentHint = hint;
            room.timeRemaining = room.settings.roundDuration;
            room.isPaused = false;

            await room.save();

            // Enviar roles individuales a cada jugador
            room.players.forEach(player => {
                io.to(player.id).emit('role-assigned', {
                    isImpostor: player.isImpostor,
                    word: player.isImpostor ? null : word,
                    hint: player.isImpostor ? hint : null
                });
            });

            io.to(data.roomCode).emit('game-started', {
                players: room.players,
                timeRemaining: room.timeRemaining
            });

            // Iniciar temporizador
            startTimer(room);
        } catch (error) {
            console.error('Error iniciando juego:', error);
        }
    });

    // Pausar/Reanudar juego
    socket.on('toggle-pause', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.isPaused = !room.isPaused;
            await room.save();

            if (room.isPaused) {
                clearInterval(roomTimers[data.roomCode]);
            } else {
                startTimer(room);
            }

            io.to(data.roomCode).emit('game-paused', { isPaused: room.isPaused });
        } catch (error) {
            console.error('Error pausando juego:', error);
        }
    });

    // Iniciar votación
    socket.on('start-voting', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            clearInterval(roomTimers[data.roomCode]);
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

            // Actualizar usando set() para asegurar que Mongoose detecte el cambio
            room.players[playerIndex].hasVoted = true;
            room.players[playerIndex].votedFor = data.votedPlayerId;

            // Marcar el array como modificado para que Mongoose lo guarde
            room.markModified('players');

            await room.save();

            // Verificar que realmente se guardó
            const verifyRoom = await Room.findOne({ roomCode: data.roomCode });
            const verifyPlayer = verifyRoom.players.find(p => p.id === socket.id);

            console.log('✅ Voto guardado. Estado actual:', {
                playerName: player.name,
                hasVoted: room.players[playerIndex].hasVoted,
                votedFor: room.players[playerIndex].votedFor,
                totalVoted: room.players.filter(p => p.hasVoted).length,
                totalPlayers: room.players.length
            });

            console.log('🔍 Verificación en DB:', {
                hasVotedInMemory: room.players[playerIndex].hasVoted,
                hasVotedInDB: verifyPlayer.hasVoted,
                votedForInMemory: room.players[playerIndex].votedFor,
                votedForInDB: verifyPlayer.votedFor
            });

            // Enviar actualización de la sala a todos los jugadores (usar sala de DB)
            console.log('📤 Enviando room-update con players:', verifyRoom.players.map(p => ({
                name: p.name,
                hasVoted: p.hasVoted,
                votedFor: p.votedFor
            })));
            io.to(data.roomCode).emit('room-update', verifyRoom);
            console.log('📤 room-update enviado a todos los jugadores');

            // Verificar si todos votaron (usar sala de DB)
            const allVoted = verifyRoom.players.every(p => p.hasVoted);

            if (allVoted) {
                // Contar votos
                const voteCounts = {};
                verifyRoom.players.forEach(p => {
                    if (p.votedFor) {
                        voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
                    }
                });

                // Encontrar al más votado
                let maxVotes = 0;
                let votedOutPlayerId = null;
                Object.entries(voteCounts).forEach(([playerId, votes]) => {
                    if (votes > maxVotes) {
                        maxVotes = votes;
                        votedOutPlayerId = playerId;
                    }
                });

                const votedOutPlayer = verifyRoom.players.find(p => p.id === votedOutPlayerId);
                const impostorFound = votedOutPlayer?.isImpostor || false;

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

    // Reiniciar juego
    socket.on('restart-game', async (data) => {
        try {
            const room = await Room.findOne({ roomCode: data.roomCode });

            if (!room || room.adminId !== socket.id) return;

            room.gameState = 'waiting';
            room.currentWord = null;
            room.currentHint = null;
            room.timeRemaining = null;
            room.isPaused = false;

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
            const rooms = await Room.find({ 'players.id': socket.id });

            for (const room of rooms) {
                room.players = room.players.filter(p => p.id !== socket.id);

                if (room.players.length === 0) {
                    await Room.deleteOne({ _id: room._id });
                    clearInterval(roomTimers[room.roomCode]);
                } else {
                    // Si el admin se desconecta, asignar nuevo admin
                    if (room.adminId === socket.id && room.players.length > 0) {
                        room.adminId = room.players[0].id;
                        room.players[0].isAdmin = true;
                    }

                    await room.save();
                    io.to(room.roomCode).emit('room-update', room);
                }
            }
        } catch (error) {
            console.error('Error en desconexión:', error);
        }
    });
});

// Función para manejar el temporizador
function startTimer(room) {
    clearInterval(roomTimers[room.roomCode]);

    roomTimers[room.roomCode] = setInterval(async () => {
        try {
            const updatedRoom = await Room.findOne({ roomCode: room.roomCode });

            if (!updatedRoom || updatedRoom.isPaused || updatedRoom.gameState !== 'started') {
                clearInterval(roomTimers[room.roomCode]);
                return;
            }

            updatedRoom.timeRemaining -= 1;

            if (updatedRoom.timeRemaining <= 0) {
                clearInterval(roomTimers[room.roomCode]);
                updatedRoom.gameState = 'voting';
                updatedRoom.timeRemaining = 0;
                await updatedRoom.save();
                io.to(room.roomCode).emit('voting-started', updatedRoom);
            } else {
                await updatedRoom.save();
                io.to(room.roomCode).emit('time-update', { timeRemaining: updatedRoom.timeRemaining });
            }
        } catch (error) {
            console.error('Error en temporizador:', error);
            clearInterval(roomTimers[room.roomCode]);
        }
    }, 1000);
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});