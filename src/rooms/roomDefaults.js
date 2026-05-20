const DEFAULT_ROOM_SETTINGS = {
  visibility: 'public',
  password: '',
  mapRadius: 2400,
  baseRadius: 120,
  playerSpeed: 1,
  maxPlayers: 16
};

const QUICK_TEST_ROOM = {
  code: 'TESTE-0001',
  visibility: 'private',
  password: 'debug',
  mapRadius: 2400,
  baseRadius: 120,
  playerSpeed: 1,
  maxPlayers: 8
};

module.exports = {
  DEFAULT_ROOM_SETTINGS,
  QUICK_TEST_ROOM
};
