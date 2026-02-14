const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Game Logic & State ---
const COLORS = ['blue', 'yellow', 'white', 'red', 'green'];
const NUMBERS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const INVESTMENTS = 3;

class Card {
    constructor(color, value, type) {
        this.id = Math.random().toString(36).substr(2, 9);
        this.color = color;
        this.value = value;
        this.type = type; // 'number' or 'investment'
    }
}

let gameState = {
    deck: [],
    board: {},
    players: [
        { id: null, name: "Player 1", hand: [], score: 0, socketId: null },
        { id: null, name: "Player 2", hand: [], score: 0, socketId: null }
    ],
    currentPlayerIndex: 0,
    turnPhase: 'play', // 'play', 'draw', 'end'
    lastDiscard: null,
    turnSummary: null,
    isGameOver: false
};

// --- Initialization Logic ---
function initGame() {
    console.log("Initializing Game...");
    gameState.deck = createDeck();
    shuffleDeck(gameState.deck);

    gameState.board = {};
    COLORS.forEach(color => {
        gameState.board[color] = {
            played: { 0: [], 1: [] },
            discard: []
        };
    });

    gameState.players.forEach(p => {
        p.hand = [];
        p.score = 0;
        p.socketId = null; // Reset sockets on init
    });

    gameState.currentPlayerIndex = 0;
    gameState.turnPhase = 'play';
    gameState.isGameOver = false;
    gameState.turnSummary = null;
    gameState.lastDiscard = null;

    dealCards();
}

function createDeck() {
    const deck = [];
    COLORS.forEach(color => {
        NUMBERS.forEach(num => deck.push(new Card(color, num, 'number')));
        for (let i = 0; i < INVESTMENTS; i++) deck.push(new Card(color, 0, 'investment'));
    });
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function dealCards() {
    for (let i = 0; i < 8; i++) {
        gameState.players.forEach(player => {
            if (gameState.deck.length > 0) player.hand.push(gameState.deck.pop());
        });
    }
}

// --- Action Handlers ---
function checkGameReady() {
    return gameState.players[0].socketId && gameState.players[1].socketId;
}

function handlePlayCard(playerIndex, cardId) {
    if (gameState.isGameOver) return { success: false, msg: "이미 게임이 종료되었습니다." };
    if (!checkGameReady()) return { success: false, msg: "두 명의 플레이어가 모두 접속해야 게임을 시작할 수 있습니다." };
    if (gameState.currentPlayerIndex !== playerIndex) return { success: false, msg: "당신의 턴이 아닙니다." };
    if (gameState.turnPhase !== 'play') return { success: false, msg: "지금은 카드를 뽑아야 합니다." };

    const player = gameState.players[playerIndex];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);

    if (cardIndex === -1) return { success: false, msg: "유효하지 않은 카드입니다." };

    const card = player.hand[cardIndex];
    const playedStack = gameState.board[card.color].played[playerIndex];

    // Rule Check
    if (playedStack.length > 0) {
        const topCard = playedStack[playedStack.length - 1];
        if (topCard.value > card.value && card.type !== 'investment') return { success: false, msg: "카드는 오름차순으로만 낼 수 있습니다." };
        if (topCard.type === 'number' && card.type === 'investment') return { success: false, msg: "투자 카드는 숫자 카드보다 먼저 내야 합니다." };
        if (card.value < topCard.value) return { success: false, msg: "카드는 오름차순으로만 낼 수 있습니다." };
    }

    player.hand.splice(cardIndex, 1);
    playedStack.push(card);
    gameState.lastDiscard = null;
    gameState.turnSummary = { action: '내기 (Play)', card };
    gameState.turnPhase = 'draw';

    return { success: true };
}

function handleDiscardCard(playerIndex, cardId) {
    if (gameState.isGameOver) return { success: false, msg: "이미 게임이 종료되었습니다." };
    if (!checkGameReady()) return { success: false, msg: "두 명의 플레이어가 모두 접속해야 게임을 시작할 수 있습니다." };
    if (gameState.currentPlayerIndex !== playerIndex) return { success: false, msg: "당신의 턴이 아닙니다." };
    if (gameState.turnPhase !== 'play') return { success: false, msg: "지금은 카드를 뽑아야 합니다." };

    const player = gameState.players[playerIndex];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);

    if (cardIndex === -1) return { success: false, msg: "유효하지 않은 카드입니다." };

    const card = player.hand[cardIndex];

    player.hand.splice(cardIndex, 1);
    gameState.board[card.color].discard.push(card);
    gameState.lastDiscard = { playerIndex, color: card.color, cardId: card.id };
    gameState.turnSummary = { action: '버리기 (Discard)', card };
    gameState.turnPhase = 'draw';

    return { success: true };
}

function handleDrawCard(playerIndex, source, color) {
    if (gameState.isGameOver) return { success: false, msg: "이미 게임이 종료되었습니다." };
    if (!checkGameReady()) return { success: false, msg: "두 명의 플레이어가 모두 접속해야 게임을 시작할 수 있습니다." };
    if (gameState.currentPlayerIndex !== playerIndex) return { success: false, msg: "당신의 턴이 아닙니다." };
    if (gameState.turnPhase !== 'draw') return { success: false, msg: "카드를 낸 후에 뽑을 수 있습니다." };

    const player = gameState.players[playerIndex];
    let newCard = null;

    if (source === 'deck') {
        if (gameState.deck.length === 0) {
            endGame();
            return { success: true, gameOver: true };
        }
        newCard = gameState.deck.pop();
    } else if (source === 'discard') {
        const discardPile = gameState.board[color].discard;
        if (discardPile.length === 0) return { success: false, msg: "가져올 카드가 없습니다." };
        if (gameState.lastDiscard && gameState.lastDiscard.playerIndex === playerIndex && gameState.lastDiscard.color === color) {
            return { success: false, msg: "방금 버린 카드는 바로 가져올 수 없습니다." };
        }
        newCard = discardPile.pop();
    }

    player.hand.push(newCard);

    if (gameState.deck.length === 0) {
        endGame();
    } else {
        handleNextTurn();
    }
    return { success: true };
}

function handleNextTurn() {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % 2;
    gameState.turnPhase = 'play';
    gameState.turnSummary = null;
}

function endGame() {
    gameState.isGameOver = true;
    calculateFinalScore();
    const finalScores = gameState.players.map(p => p.score);
    io.emit('game_over', {
        scores: finalScores,
        gameState: gameState
    });
    io.emit('update_board', gameState);
}

function calculateFinalScore() {
    gameState.players.forEach((player, pIndex) => {
        let totalScore = 0;
        COLORS.forEach(color => {
            const played = gameState.board[color].played[pIndex];
            let sum = 0, multipliers = 1, count = 0, hasCards = played.length > 0;
            if (!hasCards) return;
            played.forEach(c => {
                if (c.type === 'investment') multipliers++;
                else sum += c.value;
                count++;
            });
            let colorScore = (sum - 20) * multipliers;
            if (count >= 8) colorScore += 20;
            totalScore += colorScore;
        });
        player.score = totalScore;
    });
}

// Initialize on start
initGame();

// --- Socket.io Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Identify Client Type
    socket.on('identify', (type) => {
        console.log(`Socket ${socket.id} identified as ${type}`);
        if (type === 'host') {
            // Send full board state
            socket.emit('update_board', gameState);

            // Generate QR Code for Mobile URL
            const networks = os.networkInterfaces();
            let ipAddress = 'localhost';
            for (const name of Object.keys(networks)) {
                for (const net of networks[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        ipAddress = net.address;
                        break;
                    }
                }
            }
            const mobileUrl = `http://${ipAddress}:3000/mobile.html`;
            console.log(`Generated Mobile URL: ${mobileUrl}`);
            QRCode.toDataURL(mobileUrl, (err, url) => {
                if (err) console.error("QR Gen Error:", err);
                socket.emit('init_host', {
                    qrCodeDataURL: url,
                    ipAddress: ipAddress,
                    port: 3000
                });
            });
        }
    });

    // Mobile Join Request
    socket.on('join_player', (data) => {
        const pIndex = data.playerIndex;

        // Check if player slot is already occupied
        if (gameState.players[pIndex].socketId && gameState.players[pIndex].socketId !== socket.id) {
            socket.emit('join_error', { msg: `이미 플레이어 ${pIndex + 1}이(가) 접속 중입니다.` });
            return;
        }

        // Assign socket to player
        gameState.players[pIndex].socketId = socket.id;
        console.log(`Socket ${socket.id} assigned to Player ${pIndex + 1}`);

        // Confirm success to the user
        socket.emit('join_success', { playerIndex: pIndex });

        // Send initial hand
        socket.emit('hand_update', gameState.players[pIndex].hand);

        // Notify Host and others - Sync Board State (Triggers UI update on PC)
        io.emit('update_board', gameState);
        io.emit('player_joined', { playerIndex: pIndex });

        // Broadcast turn status to ALL players to ensure everyone is synced on connection status
        gameState.players.forEach((p, idx) => {
            if (p.socketId) {
                io.to(p.socketId).emit('turn_update', {
                    currentPlayerIndex: gameState.currentPlayerIndex,
                    turnPhase: gameState.turnPhase,
                    bothConnected: checkGameReady(),
                    isInitialJoin: (p.socketId === socket.id),
                    deckCount: gameState.deck.length,
                    board: gameState.board,
                    lastDiscard: gameState.lastDiscard
                });
            }
        });
    });

    // Mobile Actions
    socket.on('play_card', (data) => {
        // data.card is the card object sent from mobile
        const res = handlePlayCard(data.playerIndex, data.card.id);
        if (res.success) {
            io.emit('update_board', gameState);
            gameState.players.forEach((p) => {
                if (p.socketId) {
                    io.to(p.socketId).emit('hand_update', p.hand);
                    io.to(p.socketId).emit('turn_update', {
                        currentPlayerIndex: gameState.currentPlayerIndex,
                        turnPhase: gameState.turnPhase,
                        bothConnected: checkGameReady(),
                        deckCount: gameState.deck.length,
                        board: gameState.board,
                        lastDiscard: gameState.lastDiscard
                    });
                }
            });
        } else {
            socket.emit('error_msg', res.msg);
        }
    });

    socket.on('discard_card', (data) => {
        const res = handleDiscardCard(data.playerIndex, data.card.id);
        if (res.success) {
            io.emit('update_board', gameState);
            gameState.players.forEach((p) => {
                if (p.socketId) {
                    io.to(p.socketId).emit('hand_update', p.hand);
                    io.to(p.socketId).emit('turn_update', {
                        currentPlayerIndex: gameState.currentPlayerIndex,
                        turnPhase: gameState.turnPhase,
                        bothConnected: checkGameReady(),
                        deckCount: gameState.deck.length,
                        board: gameState.board,
                        lastDiscard: gameState.lastDiscard
                    });
                }
            });
        } else {
            socket.emit('error_msg', res.msg);
        }
    });

    socket.on('draw_card', (data) => {
        const res = handleDrawCard(gameState.currentPlayerIndex, data.source, data.color);
        if (res.success) {
            io.emit('update_board', gameState);
            gameState.players.forEach((p) => {
                if (p.socketId) {
                    io.to(p.socketId).emit('hand_update', p.hand);
                    io.to(p.socketId).emit('turn_update', {
                        currentPlayerIndex: gameState.currentPlayerIndex,
                        turnPhase: gameState.turnPhase,
                        bothConnected: checkGameReady(),
                        deckCount: gameState.deck.length,
                        board: gameState.board,
                        lastDiscard: gameState.lastDiscard
                    });
                }
            });
        } else {
            socket.emit('error_msg', res.msg);
        }
    });

    socket.on('confirm_end_turn', () => {
        handleNextTurn();
        io.emit('update_board', gameState);
        gameState.players.forEach((p) => {
            if (p.socketId) {
                io.to(p.socketId).emit('hand_update', p.hand);
                io.to(p.socketId).emit('turn_update', {
                    currentPlayerIndex: gameState.currentPlayerIndex,
                    turnPhase: gameState.turnPhase,
                    bothConnected: checkGameReady()
                });
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        // Find player and clear socket
        let pIndex = gameState.players.findIndex(p => p.socketId === socket.id);
        if (pIndex !== -1) {
            gameState.players[pIndex].socketId = null;
            console.log(`Player ${pIndex + 1} disconnected.`);

            // Notify Host to show pause screen
            io.emit('update_board', gameState);

            // Notify other mobile player if connected
            const otherPlayer = gameState.players[pIndex === 0 ? 1 : 0];
            if (otherPlayer.socketId) {
                io.to(otherPlayer.socketId).emit('turn_update', {
                    currentPlayerIndex: gameState.currentPlayerIndex,
                    turnPhase: gameState.turnPhase,
                    bothConnected: false
                });
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);

    // Auto-open browser (Host Screen)
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}`;
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';

    // Using 'start chrome' specifically if available, else system default
    exec(`${startCmd} "" "${url}"`, (err) => {
        if (err) console.log("Could not auto-open browser, please open manually:", url);
    });
});
