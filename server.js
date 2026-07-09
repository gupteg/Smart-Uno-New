const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require("socket.io");
require('dotenv').config(); // For HOST_PASSWORD

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SERVER-SIDE GAME STATE ---
let players = []; // Lobby players { playerId, socketId, name, isHost, isReady, active(temp?) }
let gameState = null;
let globalPauseTimeout = null; // NEW: Single timer for pause duration
let gameOverToLobbyTimer = null; // Timer for Game Over -> Scoreboard delay
let scoresToLobbyTimer = null; // Timer for Scoreboard -> Lobby transition
const DISCONNECT_GRACE_PERIOD = 60000; // 60 seconds
const HOST_PASSWORD = process.env.HOST_PASSWORD || null;

// --- GAME LOGIC FUNCTIONS ---

function addLog(message) {
    if (!gameState || !gameState.gameLog) return;
    gameState.gameLog.unshift(message);
    if (gameState.gameLog.length > 50) {
        gameState.gameLog.pop();
    }
}

function createDeck() { const deck = []; const colors = ['Red', 'Green', 'Blue', 'Yellow']; const values = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw Two']; for (const color of colors) { deck.push({ color, value: '0' }); for (let i = 0; i < 2; i++) { for (const value of values) { deck.push({ color, value }); } } } for (let i = 0; i < 4; i++) { deck.push({ color: 'Black', value: 'Wild' }); deck.push({ color: 'Black', value: 'Wild Draw Four' }); deck.push({ color: 'Black', value: 'Wild Pick Until' }); } deck.push({ color: 'Black', value: 'Wild Swap' }); return deck; }
function calculateScore(hand) { let score = 0; hand.forEach(card => { if (!isNaN(card.value)) { score += parseInt(card.value); } else { switch(card.value) { case 'Wild Swap': score += 100; break; case 'Draw Two': score += 25; break; case 'Skip': case 'Reverse': score += 20; break; default: score += 50; break; } } }); return score; }
function shuffleDeck(deck) { for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; } return deck; }

function setupGame(lobbyPlayers) {
    const gamePlayers = lobbyPlayers.map(p => ({
        playerId: p.playerId,
        socketId: p.socketId,
        name: p.name,
        isHost: p.isHost,
        score: 0,
        hand: [],
        unoState: 'safe',
        scoresByRound: [],
        status: 'Active',
    }));

    return {
        phase: 'Lobby', // Start phase as Lobby, will change immediately
        players: gamePlayers,
        dealerIndex: -1, // Will be set to 0 (the host) in startGame
        numCardsToDeal: 7,
        discardPile: [],
        drawPile: [],
        gameWinner: null,
        winnerOnHold: [],
        roundNumber: 0,
        isPaused: false,
        pauseInfo: { pauseEndTime: null, pausedForPlayerNames: [] },
        readyForNextRound: [],
        activeColor: null,
        playDirection: 1,
        drawPenalty: 0,
        currentPlayerIndex: 0,
        playerChoosingActionId: null,
        pickUntilState: null,
        swapState: null,
        gameLog: []
    };
}

function startNewRound(gs) {
    gs.roundNumber++;
    const numPlayers = gs.players.length;

    // --- *** MODIFIED: Moved log entry to be first *** ---
    const dealer = gs.players[gs.dealerIndex];
    addLog(`Round ${gs.roundNumber} begins. ${dealer.name} deals ${gs.numCardsToDeal} cards.`);
    // --- *** END MODIFICATION *** ---

    let roundDeck = shuffleDeck(createDeck());
    gs.players.forEach(player => {
        if (player.status === 'Active') {
            player.hand = roundDeck.splice(0, gs.numCardsToDeal);
            player.unoState = 'safe';
        } else {
            player.hand = [];
        }
    });
    let topCard = roundDeck.shift();
    while (topCard.value === 'Wild Draw Four' || topCard.value === 'Wild Swap') {
        roundDeck.push(topCard);
        roundDeck = shuffleDeck(roundDeck);
        topCard = roundDeck.shift();
    }
    gs.discardPile = [{ card: topCard, playerName: 'Deck' }];

    // --- *** Log initial discard card (from previous change) *** ---
    const cardName = `${topCard.color !== 'Black' ? topCard.color + ' ' : ''}${topCard.value}`;
    addLog(`The Deck opened with a ${cardName}.`);
    // --- *** END *** ---

    gs.drawPile = roundDeck;
    gs.activeColor = topCard.color;
    gs.playDirection = 1;
    gs.drawPenalty = 0;
    gs.pickUntilState = null;
    gs.swapState = null;
    gs.winnerOnHold = [];
    gs.isPaused = false;
    gs.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] };
    gs.readyForNextRound = [];
    gs.playerChoosingActionId = null;
    
    // --- *** (Dealing log was removed from here) *** ---
    
    let firstPlayerIndex = (gs.dealerIndex + 1) % numPlayers;
    while (gs.players[firstPlayerIndex].status !== 'Active') {
        firstPlayerIndex = (firstPlayerIndex + 1) % numPlayers;
        if (firstPlayerIndex === (gs.dealerIndex + 1) % numPlayers) break;
    }
    gs.currentPlayerIndex = firstPlayerIndex;
    if (topCard.color !== 'Black') {
        const connectedPlayersCount = gs.players.filter(p => p.status === 'Active').length;
        if (topCard.value === 'Reverse') {
            if (connectedPlayersCount > 2) {
                gs.playDirection = -1;
                let tempIndex = gs.dealerIndex;
                do {
                    tempIndex = (tempIndex - 1 + numPlayers) % numPlayers;
                } while (gs.players[tempIndex].status !== 'Active');
                gs.currentPlayerIndex = tempIndex;
            } else {
                let tempIndex = firstPlayerIndex;
                do {
                    tempIndex = (tempIndex + 1 + numPlayers) % numPlayers;
                } while (gs.players[tempIndex].status !== 'Active');
                gs.currentPlayerIndex = tempIndex;
            }
        } else if (topCard.value === 'Skip') {
            let tempIndex = firstPlayerIndex;
            do {
                tempIndex = (tempIndex + 1 + numPlayers) % numPlayers;
            } while (gs.players[tempIndex].status !== 'Active');
            gs.currentPlayerIndex = tempIndex;
        }
        if (topCard.value === 'Draw Two') {
            applyCardEffect(topCard);
        }
        gs.phase = 'Playing';
    } else {
        gs.discardPile[0].playerName = dealer.name;
        gs.playerChoosingActionId = dealer.playerId;
        if (topCard.value === 'Wild Pick Until') {
            gs.phase = 'ChoosingPickUntilAction';
        } else {
            gs.phase = 'ChoosingColor';
        }
    }
    return gs;
}
function isMoveValid(playedCard, topCard, activeColor, drawPenalty) { if (drawPenalty > 0) return playedCard.value === topCard.value; if (playedCard.color === 'Black') return true; return playedCard.color === activeColor || playedCard.value === topCard.value; }
function checkIfPlayerMustPlay(player, topCard, activeColor) { if (!player || !player.hand || player.hand.length === 0) { return false; } for (const card of player.hand) { if (card.color !== 'Black') { if (card.color === activeColor || card.value === topCard.value) { return true; } } } return false; }
function advanceTurn() { if (!gameState) return; const activePlayers = gameState.players.filter(p => p.status === 'Active'); if (activePlayers.length === 0) { addLog("No active players left to advance turn."); return; } const currentPlayer = gameState.players[gameState.currentPlayerIndex]; if (currentPlayer && currentPlayer.unoState === 'declared') { currentPlayer.unoState = 'safe'; } do { const numPlayers = gameState.players.length; gameState.currentPlayerIndex = (gameState.currentPlayerIndex + gameState.playDirection + numPlayers) % numPlayers; } while (gameState.players[gameState.currentPlayerIndex].status !== 'Active'); }
function applyCardEffect(playedCard) { switch(playedCard.value) { case 'Reverse': if (gameState.players.filter(p=>p.status === 'Active').length > 2) { gameState.playDirection *= -1; } break; case 'Draw Two': case 'Wild Draw Four': const penalty = (playedCard.value === 'Draw Two') ? 2 : 4; gameState.drawPenalty += penalty; break; } }
function handleEndOfRound(winners) { if (!gameState || gameState.phase === 'RoundOver' || gameState.phase === 'GameOver') return; gameState.phase = 'RoundOver'; gameState.readyForNextRound = []; const scoresForRound = []; gameState.players.forEach(p => { const roundScore = (p.status === 'Active' || p.status === 'Disconnected') ? calculateScore(p.hand) : 0; p.score += roundScore; p.scoresByRound.push((p.status === 'Active' || p.status === 'Disconnected') ? roundScore : '-'); scoresForRound.push({ name: p.name, roundScore: roundScore, cumulativeScore: p.score }); }); const winnerNames = winners.map(w => w.name).join(' and '); addLog(`🏁 ${winnerNames} wins the round!`); io.emit('announceRoundWinner', { winnerNames }); io.emit('roundOver', { winnerName: winnerNames, scores: scoresForRound, finalGameState: gameState }); }
function handleCardPlay(playerIndex, cardIndex) { 
    if (!gameState || gameState.phase !== 'Playing' || playerIndex !== gameState.currentPlayerIndex || gameState.isPaused) return; 
    const player = gameState.players[playerIndex]; 
    if (!player || !player.hand[cardIndex]) return; 
    const playedCard = player.hand[cardIndex]; 
    const topCard = gameState.discardPile[0].card; 
    const actionCardsThatDelayWin = ['Draw Two', 'Wild Draw Four', 'Wild Pick Until']; 
    
    if (isMoveValid(playedCard, topCard, gameState.activeColor, gameState.drawPenalty)) { 
        io.emit('animatePlay', { playerId: player.playerId, card: playedCard, cardIndex: cardIndex }); 
        player.hand.splice(cardIndex, 1); 
        const cardName = `${playedCard.color !== 'Black' ? playedCard.color + ' ' : ''}${playedCard.value}`; 
        addLog(`› ${player.name} played a ${cardName}.`); 
        
        if (player.hand.length === 1 && player.unoState !== 'declared') { 
            if (gameState.drawPile.length > 0) player.hand.push(gameState.drawPile.shift()); 
            if (gameState.drawPile.length > 0) player.hand.push(gameState.drawPile.shift()); 
            player.unoState = 'safe'; 
            
            // *** MODIFIED: Add "🚨" marker for universal announcement ***
            addLog(`🚨 Penalty on ${player.name} for not calling UNO.`); 
            
            io.emit('animateDraw', { playerId: player.playerId, count: 2 }); 
        } else if (player.hand.length === 1 && player.unoState === 'declared') { 
            io.emit('unoCalled', { playerName: player.name }); 
            player.unoState = 'safe'; 
        } else if (player.hand.length > 1) { 
            player.unoState = 'safe'; 
        } 
        
        if (player.hand.length === 0) { 
            if (actionCardsThatDelayWin.includes(playedCard.value)) { 
                gameState.winnerOnHold.push(player.playerId); 
            } else { 
                handleEndOfRound([player]); 
                return; 
            } 
        } 
        
        gameState.discardPile.unshift({ card: playedCard, playerName: player.name }); 
        
        if (playedCard.color === 'Black') { 
            gameState.playerChoosingActionId = player.playerId; 
            switch (playedCard.value) { 
                case 'Wild Pick Until': gameState.phase = 'ChoosingPickUntilAction'; break; 
                case 'Wild Swap': gameState.phase = 'ChoosingColor'; gameState.swapState = { choosingPlayerId: player.playerId }; break; 
                default: gameState.phase = 'ChoosingColor'; break; 
            } 
            if (playedCard.value === 'Wild Draw Four') { 
                applyCardEffect(playedCard); 
            } 
        } else { 
            gameState.activeColor = playedCard.color; 
            applyCardEffect(playedCard); 
            const numActivePlayers = gameState.players.filter(p => p.status === 'Active').length; 
            if (playedCard.value === 'Skip' || (playedCard.value === 'Reverse' && numActivePlayers === 2)) { 
                addLog(`› ${player.name}'s ${playedCard.value} skips the next player.`); 
                advanceTurn(); 
            } 
            advanceTurn(); 
            gameState.phase = 'Playing'; 
        } 
    } 
}
function handlePlayerRemoval(playerId) { if (!gameState) return; const player = gameState.players.find(p => p.playerId === playerId); if (player && player.status === 'Disconnected') { player.status = 'Removed'; addLog(`Player ${player.name} failed to reconnect and has been removed.`); if (player.isHost) { const nextActivePlayer = gameState.players.find(p => p.status === 'Active'); if (nextActivePlayer) { nextActivePlayer.isHost = true; addLog(`Host ${player.name} was removed. ${nextActivePlayer.name} is the new host.`); } else { addLog(`Host ${player.name} was removed. No active players left.`); } } const activePlayers = gameState.players.filter(p => p.status === 'Active'); if (activePlayers.length < 2 && gameState.phase !== 'GameOver') { addLog('Less than 2 active players remaining. Game over.'); gameState.phase = 'GameOver'; const finalGamePlayers = [...gameState.players]; const lowestScore = Math.min(...finalGamePlayers.filter(p => p.status !== 'Removed').map(p => p.score)); const winners = finalGamePlayers.filter(p => p.status !== 'Removed' && p.score === lowestScore); const winnerNames = winners.map(w => w.name).join(' and '); io.emit('announceFinalWinner', { winnerNames }); setTimeout(() => { if(gameState) io.emit('finalGameOver', gameState); setTimeout(() => { players = finalGamePlayers .filter(p => p.status !== 'Removed') .map(p => ({ playerId: p.playerId, socketId: p.socketId, name: p.name, isHost: p.isHost, isReady: p.isHost, active: true })); const hostExists = players.some(p => p.isHost); if (!hostExists && players.length > 0) { players[0].isHost = true; players[0].isReady = true; } else if (hostExists) { const host = players.find(p=>p.isHost); if(host) host.isReady = true; } gameState = null; io.emit('lobbyUpdate', players); }, 5000); }, 3000); return; } const remainingDisconnected = gameState.players.filter(p => p.status === 'Disconnected'); if (remainingDisconnected.length === 0 && gameState.isPaused) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; if (globalPauseTimeout) { clearTimeout(globalPauseTimeout); globalPauseTimeout = null; } addLog("Last disconnected player removed by timer. Game resumed."); } else if (gameState.isPaused) { gameState.pauseInfo.pausedForPlayerNames = remainingDisconnected.map(p => p.name); } const currentActivePlayer = gameState.players[gameState.currentPlayerIndex]; if (['Playing', 'ChoosingColor', 'ChoosingPickUntilAction', 'ChoosingSwapHands'].includes(gameState.phase) && currentActivePlayer?.playerId === playerId) { addLog(`It was ${player.name}'s turn. Advancing to next active player.`); if (gameState.playerChoosingActionId === playerId) { gameState.playerChoosingActionId = null; gameState.phase = 'Playing'; } advanceTurn(); } io.emit('updateGameState', gameState); } else { console.log(`handlePlayerRemoval called for ${playerId}, but player was not found or not Disconnected.`); } }


// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // *** MODIFIED: Rejoin Logic ***
  socket.on('joinGame', ({ playerName, playerId }) => {
    // Reconnection logic
    if (gameState && gameState.phase !== 'Lobby' && gameState.phase !== 'GameOver') {
        let playerToRejoin = null;
        let matchMethod = null; // To log how the match was made
        const disconnectedPlayers = gameState.players.filter(p => p.status === 'Disconnected');

        // 1. Try ID match
        if (playerId) {
            playerToRejoin = disconnectedPlayers.find(p => p.playerId === playerId);
            if(playerToRejoin) matchMethod = "ID";
            console.log(`Attempting ID match for ${playerId}: ${matchMethod ? 'Found' : 'Not Found'}`);
        }

        // 2. Try Name match (fallback)
        if (!playerToRejoin && disconnectedPlayers.length > 0) {
            // Be cautious with multiple players having the same name - maybe find first?
            playerToRejoin = disconnectedPlayers.find(p => p.name.toLowerCase() === playerName.toLowerCase());
            if(playerToRejoin) matchMethod = "Name";
            console.log(`Attempting Name match for ${playerName}: ${matchMethod ? 'Found' : 'Not Found'}`);
        }

        if (playerToRejoin) {
            console.log(`Player ${playerName} (${playerId || 'No ID'}) rejoining as ${playerToRejoin.name} using ${matchMethod} match.`);

            // Clear global timer ONLY IF this player is the ONLY one disconnected
            const stillDisconnected = gameState.players.filter(p => p.status === 'Disconnected' && p.playerId !== playerToRejoin.playerId);

            playerToRejoin.status = 'Active';
            playerToRejoin.socketId = socket.id;
            playerToRejoin.name = playerName; // Update name

            addLog(`Player ${playerToRejoin.name} has reconnected!`);

            if (stillDisconnected.length === 0) {
                gameState.isPaused = false;
                gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] };
                if (globalPauseTimeout) {
                    clearTimeout(globalPauseTimeout);
                    globalPauseTimeout = null;
                    console.log("All players reconnected, clearing global pause timer.");
                }
                addLog("All players reconnected. Game resumed.");
            } else {
                gameState.pauseInfo.pausedForPlayerNames = stillDisconnected.map(p => p.name);
                console.log(`Player ${playerToRejoin.name} reconnected, but others still disconnected. Timer continues.`);
            }

            // --- Send joinSuccess ACKNOWLEDGEMENT ---
            // Send player list from *lobby* array if available, otherwise maybe just the player ID?
            // Let's send the game state players list for context, similar to Judgement
            socket.emit('joinSuccess', { playerId: playerToRejoin.playerId, lobby: gameState.players });
            // -----------------------------------------

            io.emit('updateGameState', gameState); // Send updated state to everyone
            return;
        } else {
             console.log(`No match found for reconnecting player ${playerName} (${playerId}).`);
            socket.emit('announce', 'Game is in progress. Cannot join now or player already removed.');
            return;
        }
    }

    // --- *** MODIFIED: New join / Lobby logic *** ---
    // No one is host on join anymore
    let pId = playerId || Math.random().toString(36).substr(2, 9);
    const existingPlayer = players.find(p => p.playerId === pId);
    if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.name = playerName;
        existingPlayer.active = true;
    } else {
        // --- *** MODIFIED: No host assignment *** ---
        const isHost = false; // players.length === 0;
        const isReady = false; // isHost;
        players.push({ playerId: pId, socketId: socket.id, name: playerName, isHost: isHost, isReady: isReady, active: true });
        // --- *** END MODIFICATION *** ---
    }
    // Use the *current* lobby 'players' array here for joinSuccess context
    socket.emit('joinSuccess', { playerId: pId, lobby: players });
    io.emit('lobbyUpdate', players);
  });
  // *** END MODIFIED Rejoin/Join Logic ***

  // --- *** NEW: claimHost Handler *** ---
  socket.on('claimHost', ({ password }) => {
    // 1. Check if a host already exists
    if (players.some(p => p.isHost)) {
        return socket.emit('announce', 'A host has already been claimed.');
    }

    // 2. Refined Password Check (uses HOST_PASSWORD from top of file)
    if (HOST_PASSWORD !== null) {
        // A password IS required
        if (password !== HOST_PASSWORD) {
            return socket.emit('announce', 'Incorrect host password.');
        }
        // Password is correct, so proceed...
    }
    // If HOST_PASSWORD is null, we skip the check
    // and the player automatically succeeds.

    // 4. Promote the player
    const newHost = players.find(p => p.socketId === socket.id);
    if (!newHost) { return; } // Safety check

    newHost.isHost = true;
    newHost.isReady = true;

    // 5. Re-order the array
    // Find the full player object first
    const newHostPlayerObject = players.find(p => p.playerId === newHost.playerId);
    // Remove newHost from their current position
    players = players.filter(p => p.playerId !== newHost.playerId);

    // Add them to the very front (index 0)
    players.unshift(newHostPlayerObject);

    // 6. Broadcast the new lobby state
    io.emit('lobbyUpdate', players);
  });
  // --- *** END NEW HANDLER *** ---


  socket.on('setPlayerReady', () => { if (gameState) return; const player = players.find(p => p.socketId === socket.id); if (player && !player.isHost) { player.isReady = !player.isReady; io.emit('lobbyUpdate', players); } });
  socket.on('kickPlayer', ({ playerIdToKick }) => { if (gameState) return; const host = players.find(p => p.socketId === socket.id && p.isHost); if (host) { const playerToKick = players.find(p => p.playerId === playerIdToKick); if (playerToKick) { console.log(`Host ${host.name} kicked ${playerToKick.name}`); players = players.filter(player => player.playerId !== playerIdToKick); io.to(playerToKick.socketId).emit('forceDisconnect'); io.emit('lobbyUpdate', players); } } });
  
  // --- *** MODIFIED: startGame handler *** ---
  socket.on('startGame', () => { // Password object removed
    if (gameState) return; 
    const host = players.find(p => p.socketId === socket.id && p.isHost); 
    if (!host) return; 

    // Password check removed - already handled by claimHost
    
    const activePlayers = players.filter(p => p.active); 
    if (activePlayers.length < 2) { 
        return socket.emit('announce', 'Need at least 2 players to start.'); 
    } 
    const allReady = activePlayers.every(p => p.isReady); 
    if (!allReady) { 
        return socket.emit('announce', 'Not all players are ready.'); 
    } 
    
    gameState = setupGame(activePlayers); 
    
    // --- *** MODIFIED: Host is now always index 0 *** ---
    const newDealerIndex = 0; // Host is always first player in array
    gameState.dealerIndex = newDealerIndex; 
    // --- *** END MODIFICATION *** ---

    gameState.playerChoosingActionId = gameState.players[newDealerIndex].playerId; 
    gameState.phase = 'Dealing'; 
    players = []; // Clear lobby array
    io.emit('updateGameState', gameState); 
  });
  // --- *** END MODIFIED startGame *** ---

  function checkAndStartNextRound() { if (!gameState || gameState.phase !== 'RoundOver') return; const host = gameState.players.find(p => p.isHost); const connectedPlayers = gameState.players.filter(p => p.status === 'Active'); if (!host) return; const hostIsReady = gameState.readyForNextRound.includes(host.playerId); const allPlayersReady = gameState.readyForNextRound.length === connectedPlayers.length; if (hostIsReady && allPlayersReady) { let newDealerIndex = (gameState.dealerIndex + 1) % gameState.players.length; let maxAttempts = gameState.players.length; while (gameState.players[newDealerIndex].status !== 'Active' && maxAttempts > 0) { addLog(`Dealer ${gameState.players[newDealerIndex].name} is not active. Skipping.`); newDealerIndex = (newDealerIndex + 1) % gameState.players.length; maxAttempts--; } if (gameState.players[newDealerIndex].status !== 'Active') { addLog("Error: No active player found to be the next dealer!"); return; } gameState.dealerIndex = newDealerIndex; const dealer = gameState.players[newDealerIndex]; gameState.playerChoosingActionId = dealer.playerId; gameState.phase = 'Dealing'; io.emit('updateGameState', gameState); } }
  socket.on('playerReadyForNextRound', () => { if (!gameState || gameState.phase !== 'RoundOver') return; const player = gameState.players.find(p => p.socketId === socket.id); if (player && player.status === 'Active' && !gameState.readyForNextRound.includes(player.playerId)) { gameState.readyForNextRound.push(player.playerId); checkAndStartNextRound(); io.emit('updateGameState', gameState); } });
  socket.on('dealChoice', ({ numCards }) => { if (!gameState || gameState.phase !== 'Dealing' || gameState.isPaused) return; const dealingPlayer = gameState.players.find(p => p.socketId === socket.id); if (gameState.playerChoosingActionId === dealingPlayer?.playerId) { const numToDeal = Math.max(1, Math.min(13, parseInt(numCards) || 7)); gameState.numCardsToDeal = numToDeal; gameState.playerChoosingActionId = null; gameState = startNewRound(gameState); io.emit('updateGameState', gameState); } });
  socket.on('endGame', () => { const player = (gameState ? gameState.players.find(p => p.socketId === socket.id) : null) || players.find(p => p.socketId === socket.id); if (player && player.isHost) { if (gameState && gameState.phase !== 'GameOver') { addLog(`The game has been ended early by the host.`); gameState.phase = 'GameOver'; const finalGamePlayers = [...gameState.players]; const lowestScore = Math.min(...finalGamePlayers.filter(p => p.status !== 'Removed').map(p => p.score)); const winners = finalGamePlayers.filter(p => p.status !== 'Removed' && p.score === lowestScore); const winnerNames = winners.map(w => w.name).join(' and '); io.emit('announceFinalWinner', { winnerNames }); if (gameOverToLobbyTimer) clearTimeout(gameOverToLobbyTimer); if (scoresToLobbyTimer) clearTimeout(scoresToLobbyTimer); gameOverToLobbyTimer = setTimeout(() => { if (!gameState) return; io.emit('finalGameOver', gameState); scoresToLobbyTimer = setTimeout(() => { if (!gameState && !players.length) return; players = finalGamePlayers .filter(p => p.status !== 'Removed') .map(p => ({ playerId: p.playerId, socketId: p.socketId, name: p.name, isHost: p.isHost, isReady: p.isHost, active: true })); const hostExists = players.some(p => p.isHost); if (!hostExists && players.length > 0) { players[0].isHost = true; players[0].isReady = true; } else if (hostExists) { const host = players.find(p=>p.isHost); if(host) host.isReady = true; } gameState = null; io.emit('lobbyUpdate', players); }, 15000); }, 3000); } else if (!gameState) { players.forEach(p => p.isReady = p.isHost); io.emit('lobbyUpdate', players); } } });
  socket.on('hardReset', () => { const host = (gameState ? gameState.players.find(p => p.socketId === socket.id && p.isHost) : null) || players.find(p => p.socketId === socket.id && p.isHost); if (host) { console.log(`Host ${host.name} initiated HARD RESET.`); const currentPlayers = gameState ? gameState.players : players; currentPlayers.forEach(p => { if (p.socketId !== host.socketId) { io.to(p.socketId).emit('forceDisconnect'); } }); gameState = null; Object.keys(reconnectTimers).forEach(key => clearTimeout(reconnectTimers[key])); reconnectTimers = {}; if (gameOverToLobbyTimer) clearTimeout(gameOverToLobbyTimer); gameOverToLobbyTimer = null; if (scoresToLobbyTimer) clearTimeout(scoresToLobbyTimer); scoresToLobbyTimer = null; if (globalPauseTimeout) clearTimeout(globalPauseTimeout); globalPauseTimeout = null; const hostData = currentPlayers.find(p => p.playerId === host.playerId); players = [{ playerId: hostData.playerId, socketId: host.socketId, name: hostData.name, isHost: true, isReady: true, active: true }]; io.emit('lobbyUpdate', players); } });
  socket.on('playCard', ({ cardIndex }) => { if (!gameState || gameState.phase !== 'Playing' || gameState.isPaused) return; const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id); if (playerIndex !== -1) { handleCardPlay(playerIndex, cardIndex); if (gameState && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') { io.emit('updateGameState', gameState); } } });
  
  socket.on('callUno', () => {
    if (!gameState || gameState.phase !== 'Playing' || gameState.isPaused) return;
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (player && player.hand.length === 2 && gameState.players[gameState.currentPlayerIndex].playerId === player.playerId) {
        player.unoState = 'declared';
        addLog(`📣 ${player.name} is ready to call UNO!`);
        
        // --- *** Add toast notification for successful UNO press (from previous change) *** ---
        io.to(player.socketId).emit('announce', 'You are ready to say UNO!');
        // --- *** END *** ---

        io.emit('updateGameState', gameState);
    }
  });
  
  // --- *** drawCard handler with premature log removed and correct log added *** ---
  socket.on('drawCard', () => {
    if (!gameState || !['Playing'].includes(gameState.phase) || gameState.isPaused) return;
    const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === gameState.currentPlayerIndex) {
        const player = gameState.players[playerIndex];
        const topCard = gameState.discardPile[0].card;

        // 1. Check for drawPenalty FIRST
        if (gameState.drawPenalty > 0) {
            const penalty = gameState.drawPenalty;
            for (let i = 0; i < penalty; i++) {
                if (gameState.drawPile.length > 0) player.hand.push(gameState.drawPile.shift());
            }
            io.emit('animateDraw', { playerId: player.playerId, count: penalty });
            addLog(`› ${player.name} drew ${penalty} cards.`);
            player.unoState = 'safe';
            gameState.drawPenalty = 0;
            if (gameState.pickUntilState?.active && gameState.pickUntilState.targetPlayerIndex === playerIndex) {
                addLog(`...and the 'Pick Until ${gameState.pickUntilState.targetColor}' action was cancelled.`);
                gameState.pickUntilState = null;
            }
            if (gameState.winnerOnHold.length > 0) {
                const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
                if (!heldWinners.some(w => w.playerId === player.playerId)) { handleEndOfRound(heldWinners); return; }
                else { gameState.winnerOnHold = []; }
            }
            advanceTurn();
            gameState.phase = 'Playing';

        // 2. Check for pickUntilState SECOND
        } else if (gameState.pickUntilState?.active && gameState.pickUntilState.targetPlayerIndex === playerIndex) {
            if (gameState.drawPile.length > 0) {
                const drawnCard = gameState.drawPile.shift();
                player.hand.push(drawnCard);
                io.emit('animateDraw', { playerId: player.playerId, count: 1 });
                addLog(`› ${player.name} is picking for a ${gameState.pickUntilState.targetColor}...`);
                if (drawnCard.color === gameState.pickUntilState.targetColor) {
                    player.hand.splice(player.hand.findIndex(c => c === drawnCard), 1);
                    gameState.discardPile.unshift({ card: drawnCard, playerName: player.name });
                    gameState.activeColor = drawnCard.color;
                    io.to(socket.id).emit('announce', `You drew the target color (${drawnCard.value} ${drawnCard.color}) and it was played for you.`);
                    addLog(`...and it was a playable ${drawnCard.color} ${drawnCard.value}!`);
                    const pickUntilChooserId = gameState.pickUntilState.chooserPlayerId;
                    gameState.pickUntilState = null; // State is resolved
                    if (player.hand.length === 0) {
                        const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
                        handleEndOfRound([player, ...heldWinners]); return;
                    }
                    if (gameState.winnerOnHold.includes(pickUntilChooserId)) {
                        const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
                        handleEndOfRound(heldWinners); return;
                    }
                    applyCardEffect(drawnCard);
                    const numActivePlayers = gameState.players.filter(p => p.status === 'Active').length;
                    if (drawnCard.value === 'Skip' || (drawnCard.value === 'Reverse' && numActivePlayers === 2)) { advanceTurn(); }
                    advanceTurn();
                    gameState.phase = 'Playing';
                } else {
                    player.unoState = 'safe';
                }
            } else {
                addLog(`Draw pile empty! ${player.name} couldn't find the color.`);
                gameState.pickUntilState = null; // State is resolved
                advanceTurn();
                gameState.phase = 'Playing';
            }
        
        // 3. Normal draw
        } else {
            if (checkIfPlayerMustPlay(player, topCard, gameState.activeColor)) {
                io.to(socket.id).emit('announce', 'You have a playable card in your hand. You must play it.');
                return;
            }
            if (gameState.drawPile.length > 0) {
                const drawnCard = gameState.drawPile.shift();
                io.emit('animateDraw', { playerId: player.playerId, count: 1 });
                
                // *** Premature log removed from here ***

                if (isMoveValid(drawnCard, topCard, gameState.activeColor, 0)) {
                    if (drawnCard.color === 'Black') {
                        player.hand.push(drawnCard);
                        const cardIndex = player.hand.length - 1;
                        io.to(socket.id).emit('updateGameState', gameState);
                        io.to(socket.id).emit('drawnWildCard', { cardIndex, drawnCard });
                        return; // Wait for player choice
                    } else {
                        const willAutoUno = player.hand.length === 1;
                        gameState.discardPile.unshift({ card: drawnCard, playerName: player.name });
                        gameState.activeColor = drawnCard.color;
                        applyCardEffect(drawnCard);
                        io.to(socket.id).emit('announce', `You drew a playable card (${drawnCard.value} ${drawnCard.color}) and it was played for you.`);
                        addLog(`...and it was a playable ${drawnCard.color} ${drawnCard.value}!`); // Log for auto-play
                        player.unoState = 'safe';
                        if (willAutoUno) { io.emit('unoCalled', { playerName: player.name }); }
                        const numActivePlayers = gameState.players.filter(p => p.status === 'Active').length;
                        if (drawnCard.value === 'Skip' || (drawnCard.value === 'Reverse' && numActivePlayers === 2)) { advanceTurn(); }
                        advanceTurn();
                        gameState.phase = 'Playing';
                    }
                } else {
                    // Card is NOT playable
                    player.hand.push(drawnCard);
                    // *** ADD LOG HERE for non-playable draw ***
                    addLog(`› ${player.name} drew a card.`); 
                    player.unoState = 'safe';
                    advanceTurn();
                    gameState.phase = 'Playing';
                }
            } else {
                addLog(`Draw pile is empty! ${player.name} passes their turn.`);
                advanceTurn();
                gameState.phase = 'Playing';
            }
        }
        
        // Send the final state update
        if (gameState && gameState.phase !== 'GameOver' && gameState.phase !== 'RoundOver' ) {
            io.emit('updateGameState', gameState);
        }
    }
  });
  // --- *** END drawCard modification *** ---

  socket.on('choosePlayDrawnWild', ({ play, cardIndex }) => { 
      if (!gameState || !['Playing'].includes(gameState.phase) || gameState.isPaused) return; 
      const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id); 
      const player = gameState.players[playerIndex]; 
      if (!player || playerIndex !== gameState.currentPlayerIndex) return; 
      
      if (play) { 
          if (cardIndex !== player.hand.length - 1) { console.error("Drawn wild card index mismatch!"); return; } 
          if (player.hand.length === 2) { player.unoState = 'declared'; } 
          gameState.phase = 'Playing'; 
          handleCardPlay(playerIndex, cardIndex); 
      } else { 
          // *** Log is generic 'drew a card' for secrecy (from previous change) ***
          addLog(`› ${player.name} drew a card.`); 
          advanceTurn(); 
          gameState.phase = 'Playing'; 
      } 
      
      if (gameState && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') { 
          io.emit('updateGameState', gameState); 
      } 
  });
  socket.on('pickUntilChoice', ({ choice }) => { if (!gameState || gameState.phase !== 'ChoosingPickUntilAction' || gameState.isPaused) return; const player = gameState.players.find(p => p.socketId === socket.id); if (gameState.playerChoosingActionId !== player?.playerId) return; const numPlayers = gameState.players.length; const originalPlayerIndex = gameState.players.findIndex(p => p.socketId === socket.id); if (choice === 'discard-wilds') { const msg = `🌪️ ${player.name} chose 'All players discard Wilds'!`; addLog(msg); io.emit('announce', msg); const winners = []; const allDiscardedData = []; gameState.players.forEach(p => { if (p.socketId !== socket.id && p.status === 'Active') { const originalHandSize = p.hand.length; if (originalHandSize > 0) { const discardedCards = p.hand.filter(card => card.color === 'Black'); if (discardedCards.length > 0) allDiscardedData.push({ playerName: p.name, cards: discardedCards }); p.hand = p.hand.filter(card => card.color !== 'Black'); if (p.hand.length === 0) winners.push(p); else if (p.hand.length === 1 && originalHandSize > 1) { p.unoState = 'declared'; io.emit('unoCalled', { playerName: p.name }); } } } }); io.emit('showDiscardWildsModal', allDiscardedData); if (allDiscardedData.length === 0) addLog('...but no other players had any Wild cards.'); if (winners.length > 0) { const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId)); handleEndOfRound([...winners, ...heldWinners]); return; } if (gameState.winnerOnHold.includes(player.playerId)) { const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId)); handleEndOfRound(heldWinners); return; } gameState.phase = 'ChoosingColor'; } else if (choice === 'pick-color') { const msg = `🎨 ${player.name} chose 'Next player picks until color'.`; addLog(msg); io.emit('announce', msg); let nextPlayerIndex = -1; let searchIndex = originalPlayerIndex; let searchLimit = numPlayers; do { searchIndex = (searchIndex + gameState.playDirection + numPlayers) % numPlayers; if (gameState.players[searchIndex].status === 'Active') { nextPlayerIndex = searchIndex; break; } searchLimit--; } while (searchLimit > 0); if (nextPlayerIndex !== -1 && nextPlayerIndex !== originalPlayerIndex) { gameState.pickUntilState = { chooserPlayerId: player.playerId, targetPlayerIndex: nextPlayerIndex, active: false, targetColor: null }; gameState.phase = 'ChoosingColor'; } else { addLog('No other active players to target. Turn continues after color choice.'); gameState.pickUntilState = null; gameState.phase = 'ChoosingColor'; } } io.emit('updateGameState', gameState); });
  socket.on('swapHandsChoice', ({ targetPlayerId }) => { if (!gameState || gameState.phase !== 'ChoosingSwapHands' || gameState.isPaused) return; const choosingPlayer = gameState.players.find(p => p.socketId === socket.id); if (gameState.playerChoosingActionId !== choosingPlayer?.playerId) return; const targetPlayer = gameState.players.find(p => p.playerId === targetPlayerId && p.status === 'Active'); if (choosingPlayer && targetPlayer) { io.emit('animateSwap', { p1_id: choosingPlayer.playerId, p2_id: targetPlayer.playerId }); [choosingPlayer.hand, targetPlayer.hand] = [targetPlayer.hand, choosingPlayer.hand]; [choosingPlayer, targetPlayer].forEach(p => { if (p.hand.length === 1) { p.unoState = 'declared'; io.emit('unoCalled', { playerName: p.name }); } else { p.unoState = 'safe'; } }); const msg = `🤝 ${choosingPlayer.name} swapped hands with ${targetPlayer.name}!`; addLog(msg); io.emit('announce', msg); gameState.playerChoosingActionId = null; gameState.swapState = null; advanceTurn(); gameState.phase = 'Playing'; } else { addLog(`Target player ${targetPlayerId} not found or not active.`); gameState.phase = 'Playing'; advanceTurn(); } io.emit('updateGameState', gameState); });
  socket.on('colorChosen', ({ color }) => { if (!gameState || gameState.phase !== 'ChoosingColor' || gameState.isPaused) return; const choosingPlayer = gameState.players.find(p => p.socketId === socket.id); if (gameState.playerChoosingActionId !== choosingPlayer?.playerId) return; addLog(`🎨 ${choosingPlayer.name} chose the color ${color}.`); gameState.activeColor = color; const wasDealerChoosingFirstCard = gameState.discardPile.length === 1 && gameState.players[gameState.dealerIndex].playerId === choosingPlayer.playerId; if (gameState.swapState) { gameState.phase = 'ChoosingSwapHands'; } else if (gameState.pickUntilState) { gameState.pickUntilState.active = true; gameState.pickUntilState.targetColor = color; gameState.currentPlayerIndex = gameState.pickUntilState.targetPlayerIndex; const targetPlayer = gameState.players[gameState.pickUntilState.targetPlayerIndex]; const msg = `› ${targetPlayer.name} must now pick until they find a ${color} card!`; addLog(msg); io.emit('announce', msg); gameState.phase = 'Playing'; gameState.playerChoosingActionId = null; } else { let announceMsg = ''; const playedCard = gameState.discardPile[0]?.card; if (!wasDealerChoosingFirstCard && playedCard) { if (playedCard.value === 'Wild Draw Four') { announceMsg = `✨ ${choosingPlayer.name} played Wild Draw Four and chose ${color}.`; } else if (playedCard.value === 'Wild') { announceMsg = `✨ ${choosingPlayer.name} played Wild and chose ${color}.`; } else { announceMsg = `✨ ${choosingPlayer.name} chose ${color}.`; } io.emit('announce', announceMsg); } if (!wasDealerChoosingFirstCard) { advanceTurn(); } gameState.phase = 'Playing'; gameState.playerChoosingActionId = null; } io.emit('updateGameState', gameState); });
  socket.on('rearrangeHand', ({ newHand }) => { if (!gameState) return; const player = gameState.players.find(p => p.socketId === socket.id); if (player) { if (newHand.length === player.hand.length) { player.hand = newHand; } } });
  socket.on('markPlayerAFK', ({ playerIdToMark }) => { if (!gameState || ['Lobby', 'GameOver'].includes(gameState.phase)) return; const host = gameState.players.find(p => p.socketId === socket.id && p.isHost); const playerToMark = gameState.players.find(p => p.playerId === playerIdToMark); if (host && playerToMark && playerToMark.status === 'Active') { playerToMark.status = 'Disconnected'; addLog(`Host ${host.name} marked ${playerToMark.name} as AFK. Game pause timer updated/started.`); gameState.isPaused = true; const newPauseEndTime = Date.now() + DISCONNECT_GRACE_PERIOD; gameState.pauseInfo.pauseEndTime = newPauseEndTime; gameState.pauseInfo.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name); if (globalPauseTimeout) clearTimeout(globalPauseTimeout); globalPauseTimeout = setTimeout(() => { if (gameState && gameState.isPaused && Date.now() >= gameState.pauseInfo.pauseEndTime) { console.log(`Global pause timer expired at ${new Date()}. Checking for removals.`); const playersToRemove = gameState.players.filter(p => p.status === 'Disconnected'); playersToRemove.forEach(p => { handlePlayerRemoval(p.playerId); }); if (gameState && !gameState.players.some(p => p.status === 'Disconnected')) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; console.log("All disconnected players removed by timer, resuming game."); io.emit('updateGameState', gameState); } } globalPauseTimeout = null; }, DISCONNECT_GRACE_PERIOD + 1000); io.to(playerToMark.socketId).emit('youWereMarkedAFK'); io.emit('updateGameState', gameState); } });
  socket.on('playerIsBack', () => { if (!gameState || gameState.phase === 'GameOver') return; const player = gameState.players.find(p => p.socketId === socket.id); if (player && player.status === 'Disconnected') { player.status = 'Active'; addLog(`Player ${player.name} is back!`); const stillDisconnected = gameState.players.filter(p => p.status === 'Disconnected'); if (stillDisconnected.length === 0 && gameState.isPaused) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; if (globalPauseTimeout) { clearTimeout(globalPauseTimeout); globalPauseTimeout = null; console.log("All players back, clearing global pause timer."); } addLog("All players are back. Game resumed."); } else if (gameState.isPaused) { gameState.pauseInfo.pausedForPlayerNames = stillDisconnected.map(p => p.name); console.log(`Player ${player.name} back, but others still disconnected. Timer continues.`); } io.emit('updateGameState', gameState); } });

  // *** MODIFIED: Disconnect uses global timer logic ***
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (gameState && gameState.phase !== 'GameOver') {
        const disconnectedPlayer = gameState.players.find(p => p.socketId === socket.id);
        if (disconnectedPlayer && disconnectedPlayer.status === 'Active') {
            disconnectedPlayer.status = 'Disconnected';
            addLog(`Player ${disconnectedPlayer.name} has disconnected. Game pause timer updated/started.`);
            gameState.isPaused = true;
            const newPauseEndTime = Date.now() + DISCONNECT_GRACE_PERIOD;
            gameState.pauseInfo.pauseEndTime = newPauseEndTime; // Update with latest time
            gameState.pauseInfo.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name);

            // Reset global timer
            if (globalPauseTimeout) clearTimeout(globalPauseTimeout);
            globalPauseTimeout = setTimeout(() => {
                if (gameState && gameState.isPaused && Date.now() >= gameState.pauseInfo.pauseEndTime) {
                    console.log(`Global pause timer expired at ${new Date()}. Checking for removals.`);
                    const playersToRemove = gameState.players.filter(p => p.status === 'Disconnected');
                    playersToRemove.forEach(p => { handlePlayerRemoval(p.playerId); });
                    if (gameState && !gameState.players.some(p => p.status === 'Disconnected')) {
                       gameState.isPaused = false;
                       gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] };
                       console.log("All disconnected players removed by timer, resuming game.");
                       io.emit('updateGameState', gameState);
                   }
                }
                globalPauseTimeout = null; // Clear timer ref
            }, DISCONNECT_GRACE_PERIOD + 1000); // Wait grace period + buffer

            io.emit('updateGameState', gameState); // Update everyone with new pause state
        }
    } else { 
        // --- *** MODIFIED: Handle lobby disconnect (new logic) *** ---
        const playerInLobby = players.find(player => player.socketId === socket.id);
        if (playerInLobby) {
            playerInLobby.active = false;
            let hostLeft = false;

            if (playerInLobby.isHost) {
                playerInLobby.isHost = false; // Revoke host status
                hostLeft = true;
                // Make all other players not-ready, forcing a new host claim
                players.forEach(p => {
                    if (p.playerId !== playerInLobby.playerId) {
                        p.isReady = false;
                    }
                });
                console.log(`Host ${playerInLobby.name} disconnected. Lobby is now hostless.`);
            }

            if (!players.some(p => p.active)) {
                 players = []; // Clear lobby if last player leaves
                 console.log("Last active player left lobby. Clearing lobby.");
            }
            io.emit('lobbyUpdate', players);
        }
        // --- *** END MODIFIED LOBBY DISCONNECT *** ---
    }
  });

}); // End of io.on('connection', ...)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`✅ UNO Server is live and listening on port ${PORT}`); });