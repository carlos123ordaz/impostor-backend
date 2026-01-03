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
        category: { type: String, default: 'all' },
        impostorCanSeeHint: { type: Boolean, default: false }
    },
    gameState: {
        type: String,
        enum: ['waiting', 'started', 'voting', 'ended'],
        default: 'waiting'
    },
    currentWord: { type: String, default: null },
    currentHint: { type: String, default: null },
    isPaused: { type: Boolean, default: false },
    turnOrder: [{ type: String }], // IDs de jugadores en orden de turnos
    currentTurnIndex: { type: Number, default: 0 },
    votes: { type: Map, of: Number, default: {} },
    createdAt: { type: Date, default: Date.now, expires: 86400 }
}, { timestamps: true });

module.exports = mongoose.model('Room', RoomSchema);