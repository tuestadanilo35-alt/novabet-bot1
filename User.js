const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    coins: { type: Number, default: 0 },
    jugadas: { type: Number, default: 0 },
    ganadas: { type: Number, default: 0 },
    rachaActual: { type: Number, default: 0 },
    rachaMaxima: { type: Number, default: 0 },
    historial: { type: Array, default: [] },
    bloqueadoFilas: { type: Boolean, default: false }
});

module.exports = mongoose.model('User', userSchema);
