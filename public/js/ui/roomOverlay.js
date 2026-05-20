const ROOM_MENU_KEY = 'KeyO';
const QUICK_JOIN_KEY = 'KeyP';

export function createRoomOverlay(socket) {
  const overlay = buildOverlay();
  const roomCodeInput = overlay.querySelector('[data-room-code]');
  const roomPasswordInput = overlay.querySelector('[data-room-password]');
  const roomVisibility = overlay.querySelector('[data-room-visibility]');

  document.body.appendChild(overlay);

  window.addEventListener('keydown', event => {
    if (event.code === ROOM_MENU_KEY) {
      overlay.hidden = !overlay.hidden;
    }

    if (event.code === QUICK_JOIN_KEY) {
      socket.emit('joinQuickTestRoom');
    }
  });

  overlay.querySelector('[data-create-room]').addEventListener('click', () => {
    socket.emit('createRoom', {
      visibility: roomVisibility.value,
      password: roomPasswordInput.value,
      roomCode: roomCodeInput.value
    });
  });

  overlay.querySelector('[data-join-room]').addEventListener('click', () => {
    socket.emit('joinRoom', {
      code: roomCodeInput.value,
      password: roomPasswordInput.value
    });
  });
}

function buildOverlay() {
  const wrapper = document.createElement('section');

  wrapper.hidden = true;
  wrapper.className = 'room-overlay';
  wrapper.innerHTML = `
    <div class="room-overlay__panel">
      <h2>Salas Online</h2>
      <input data-room-code placeholder="Código da sala" />
      <input data-room-password placeholder="Senha (opcional)" />
      <select data-room-visibility>
        <option value="public">Pública</option>
        <option value="private">Privada</option>
      </select>
      <div class="room-overlay__actions">
        <button data-create-room>Criar sala</button>
        <button data-join-room>Entrar</button>
      </div>
      <small>Atalho: O abre o menu / P entra na sala de teste.</small>
    </div>
  `;

  return wrapper;
}
