const crypto = require('crypto');
const { DEFAULT_ROOM_SETTINGS, QUICK_TEST_ROOM } = require('./roomDefaults');

function createRoomManager() {
  const rooms = new Map();
  createRoom({ settings: QUICK_TEST_ROOM, fixedCode: QUICK_TEST_ROOM.code });

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    getPublicRooms,
    getSpectatorTarget,
    getRoom
  };

  function createRoom({ settings = DEFAULT_ROOM_SETTINGS, fixedCode } = {}) {
    const code = fixedCode || generateCode();
    const room = {
      code,
      players: new Set(),
      createdAt: Date.now(),
      settings: {
        ...DEFAULT_ROOM_SETTINGS,
        ...settings
      }
    };

    rooms.set(code, room);
    return room;
  }

  function joinRoom(code, playerId, password = '') {
    const room = rooms.get(code);

    if (!room) {
      return { ok: false, reason: 'Sala não encontrada.' };
    }

    if (room.settings.visibility === 'private' && room.settings.password !== password) {
      return { ok: false, reason: 'Senha inválida.' };
    }

    room.players.add(playerId);
    return { ok: true, room };
  }

  function leaveRoom(code, playerId) {
    const room = rooms.get(code);

    if (!room) {
      return;
    }

    room.players.delete(playerId);

    if (room.players.size === 0 && code !== QUICK_TEST_ROOM.code) {
      rooms.delete(code);
    }
  }

  function getPublicRooms() {
    return [...rooms.values()].filter(room => room.settings.visibility === 'public');
  }

  function getSpectatorTarget() {
    const publicRooms = getPublicRooms().filter(room => room.players.size > 0);

    if (publicRooms.length === 0) {
      return null;
    }

    const room = publicRooms[Math.floor(Math.random() * publicRooms.length)];
    const players = [...room.players];

    return {
      roomCode: room.code,
      playerId: players[Math.floor(Math.random() * players.length)]
    };
  }

  function getRoom(code) {
    return rooms.get(code);
  }

  function generateCode() {
    let code = '';

    while (!code || rooms.has(code)) {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
    }

    return code;
  }
}

module.exports = {
  createRoomManager
};
