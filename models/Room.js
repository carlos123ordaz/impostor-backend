const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    isImpostor: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    hasVoted: { type: Boolean, default: false },
    votedFor: { type: String, default: null },
    isAlive: { type: Boolean, default: true }
});

const RoomSchema = new mongoose.Schema({
    roomCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    players: [PlayerSchema],
    adminId: { type: String, required: true },
    settings: {
        impostorCount: { type: Number, default: 1 },
        roundDuration: { type: Number, default: 120 }, // segundos
        category: { type: String, default: 'all' }, // all, animales, lugares, objetos, comida, etc.
        impostorCanSeeHint: { type: Boolean, default: false } // si el impostor puede ver la pista
    },
    gameState: {
        type: String,
        enum: ['waiting', 'started', 'voting', 'ended'],
        default: 'waiting'
    },
    currentWord: { type: String, default: null },
    currentHint: { type: String, default: null },
    timeRemaining: { type: Number, default: null },
    isPaused: { type: Boolean, default: false },
    votes: { type: Map, of: Number, default: {} },
    createdAt: { type: Date, default: Date.now, expires: 86400 } // 24 horas
}, { timestamps: true });

module.exports = mongoose.model('Room', RoomSchema);