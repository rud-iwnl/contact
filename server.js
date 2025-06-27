const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');
const http = require('http');
const server = http.createServer();
const io = require('socket.io')(server);
const app = express();

const PORT = process.env.PORT || 3000;

// Запуск WebSocket-сервера на порту 3000
const wss = new WebSocket.Server({ port: 3000 });

// Структура для хранения всех лобби
// Формат: { [lobbyId]: { players: [...], state, ... } }
const lobbies = {};

/**
 * Отправляет сообщение всем игрокам в лобби
 * @param {string} lobbyId - идентификатор лобби
 * @param {object} data - данные для отправки (будут сериализованы в JSON)
 */
function broadcast(lobbyId, data) {
  if (!lobbies[lobbyId]) return;
  lobbies[lobbyId].players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

/**
 * Возвращает публичное состояние лобби (без секретных данных)
 * @param {string} lobbyId
 * @returns {object|null}
 */
function getPublicLobbyState(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return null;
  return {
    players: lobby.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isLead: p.isLead })),
    state: lobby.state,
    wordLength: lobby.wordLength,
    opened: lobby.opened,
    usedWords: lobby.usedWords,
    contact: lobby.contact,
    timer: lobby.timer,
    chat: lobby.chat,
    rules: lobby.rules,
    leadId: lobby.leadId,
    wordFirstLetter: lobby.wordFirstLetter,
  };
}

// Обработка новых подключений WebSocket
wss.on('connection', function connection(ws) {
  let playerId = uuidv4(); // Уникальный id игрока
  let lobbyId = null;      // id лобби, в которое вошёл игрок

  // Обработка входящих сообщений от клиента
  ws.on('message', function incoming(message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    // Присоединение к лобби
    if (msg.type === 'join') {
      // { lobbyId, name }
      lobbyId = msg.lobbyId;
      // Если лобби не существует — создаём
      if (!lobbies[lobbyId]) {
        lobbies[lobbyId] = {
          players: [],
          state: 'lobby',
          word: '',
          wordLength: 0,
          wordFirstLetter: '',
          opened: '',
          usedWords: [],
          contact: null,
          timer: null,
          chat: [],
          rules: '',
          leadId: null,
        };
      }
      // Первый игрок — хост
      const isHost = lobbies[lobbyId].players.length === 0;
      lobbies[lobbyId].players.push({ id: playerId, name: msg.name, ws, isHost, isLead: false });
      broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
    }
    if (!lobbyId || !lobbies[lobbyId]) return;
    const lobby = lobbies[lobbyId];

    // --- Игровые события ---
    switch (msg.type) {
      case 'shuffle_lead': {
        // Случайный выбор ведущего
        if (lobby.state !== 'lobby') return;
        const idx = Math.floor(Math.random() * lobby.players.length);
        lobby.players.forEach((p, i) => p.isLead = i === idx);
        lobby.leadId = lobby.players[idx].id;
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
      case 'set_lead': {
        // Ручной выбор ведущего
        if (lobby.state !== 'lobby') return;
        lobby.players.forEach(p => p.isLead = p.id === msg.playerId);
        lobby.leadId = msg.playerId;
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
      case 'start_game': {
        // Начало игры — переход к вводу слова
        if (lobby.state !== 'lobby') return;
        lobby.state = 'word_input';
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
      case 'set_word': {
        // Ведущий загадывает слово
        if (lobby.state !== 'word_input') return;
        lobby.word = msg.word.trim();
        lobby.wordLength = lobby.word.length;
        lobby.wordFirstLetter = lobby.word[0];
        lobby.opened = lobby.word[0] + '_'.repeat(lobby.word.length - 1);
        lobby.state = 'association';
        lobby.usedWords = [];
        lobby.contact = null;
        lobby.chat = [];
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
      case 'start_contact': {
        // Инициировать фазу контакта между двумя игроками
        if (lobby.state !== 'association' || lobby.contact) return;
        // { fromId, toId }
        lobby.contact = {
          fromId: msg.fromId,
          toId: msg.toId,
          words: {},
          timer: 20, // Увеличено до 20 секунд для теста
          finished: false,
        };
        lobby.timer = 20;
        broadcast(lobbyId, { type: 'contact_started', contact: lobby.contact });
        // Таймер контакта (20 секунд)
        lobby._interval = setInterval(() => {
          if (!lobby.contact) return clearInterval(lobby._interval);
          lobby.contact.timer--;
          lobby.timer = lobby.contact.timer;
          broadcast(lobbyId, { type: 'timer', timer: lobby.timer });
          if (lobby.contact.timer <= 0) {
            clearInterval(lobby._interval);
            lobby.contact.finished = true;
            broadcast(lobbyId, { type: 'contact_finished', contact: lobby.contact });
          }
        }, 1000);
        break;
      }
      case 'contact_word': {
        // Игрок отправляет слово для контакта
        // { playerId, word }
        if (!lobby.contact || lobby.contact.finished) return;
        const word = msg.word.trim();
        // Проверка: слово не должно быть использовано ранее (игнорируя регистр)
        if (lobby.usedWords.some(used => used.toLowerCase() === word.toLowerCase())) {
          // Отправить ошибку только этому игроку
          const player = lobby.players.find(p => p.id === msg.playerId);
          if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({ type: 'error', text: 'Слово уже использовано!' }));
          }
          return;
        }
        lobby.contact.words[msg.playerId] = word;
        broadcast(lobbyId, { type: 'contact_update', contact: lobby.contact });
        // Если оба участника отправили слова — завершить контакт преждевременно
        const { fromId, toId, words } = lobby.contact;
        if (words[fromId] && words[toId] && !lobby.contact.finished) {
          lobby.contact.finished = true;
          if (lobby._interval) clearInterval(lobby._interval);
          broadcast(lobbyId, { type: 'contact_finished', contact: lobby.contact });
        }
        break;
      }
      case 'contact_result': {
        // Ведущий подтверждает или отклоняет контакт
        // { success, usedWords }
        if (!lobby.contact) return;
        if (msg.success) {
          // Открыть следующую букву
          let idx = lobby.opened.indexOf('_');
          if (idx !== -1) {
            lobby.opened = lobby.opened.slice(0, idx) + lobby.word[idx] + lobby.opened.slice(idx + 1);
          }
          // Добавить только подтверждённые слова в usedWords
          if (Array.isArray(msg.usedWords) && msg.usedWords.length > 0) {
            lobby.usedWords.push(...msg.usedWords);
          }
          if (!lobby.opened.includes('_')) {
            lobby.state = 'finished';
          } else {
            lobby.state = 'association';
          }
        }
        lobby.contact = null;
        lobby.timer = null;
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
      case 'send_chat': {
        // Сообщение в игровой чат
        // { playerId, text }
        lobby.chat.push({ playerId: msg.playerId, text: msg.text });
        broadcast(lobbyId, { type: 'chat', chat: lobby.chat });
        break;
      }
      case 'reset': {
        // Сбросить игру в лобби
        lobby.state = 'lobby';
        lobby.word = '';
        lobby.wordLength = 0;
        lobby.wordFirstLetter = '';
        lobby.opened = '';
        lobby.usedWords = [];
        lobby.contact = null;
        lobby.timer = null;
        lobby.chat = [];
        lobby.leadId = null;
        lobby.players.forEach(p => p.isLead = false);
        broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
        break;
      }
    }
  });

  // Обработка отключения игрока
  ws.on('close', function () {
    if (!lobbyId || !lobbies[lobbyId]) return;
    const lobby = lobbies[lobbyId];
    // Удаляем игрока из лобби
    lobby.players = lobby.players.filter(p => p.id !== playerId);
    if (lobby.players.length === 0) {
      // Если игроков не осталось — удаляем лобби
      delete lobbies[lobbyId];
    } else {
      // Если ведущий вышел — сбросить ведущего
      if (lobby.leadId === playerId) {
        lobby.leadId = null;
        lobby.players.forEach(p => p.isLead = false);
      }
      broadcast(lobbyId, { type: 'lobby_update', lobby: getPublicLobbyState(lobbyId) });
    }
  });
});

// Раздача всех файлов из текущей папки (например, index.html)
app.use(express.static(path.join(__dirname)));

// Явный обработчик для корня (не обязателен, но полезен)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 