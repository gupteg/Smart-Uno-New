const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require("socket.io");
require('dotenv').config(); // For HOST_PASSWORD

// --- BRANCH C: Robo Player modules ---
const { RoboPlayer } = require('./server-src/player');
const { DecisionEngine, COLORS } = require('./server-src/decision-engine');
// --- END BRANCH C imports ---

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

// --- BRANCH C: Robo AI runtime state ---
const ROBO_THINK_TIME = 15000; // ms delay before robo acts (visual readability)
const ROBO_TIMEOUT    = 10000; // ms allowed for strategy.makeMove() to resolve
let roboInstances  = new Map(); // Map<playerId, RoboPlayer> — never serialised to client
let roboTurnPending = false;    // Prevents double-scheduling
// --- END BRANCH C state ---

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

// --- BRANCH A: Draw Pile Reshuffle ---
/**
 * Reshuffle the discard pile into the draw pile when draw pile is exhausted.
 * Keeps the top discard card (to maintain the active game state).
 * Returns true if reshuffle succeeded, false if both piles are depleted.
 */
function reshuffleDiscardIntoDraw(gs) {
    // Need at least 2 cards in discard pile: top card (stays) + 1+ to recycle
    if (gs.discardPile.length <= 1) {
        return false; // Can't reshuffle: discard pile too small
    }
    
    // Extract all cards EXCEPT the top one
    const cardsToShuffle = gs.discardPile.slice(1).map(entry => entry.card);
    
    // Shuffle them back into draw pile
    gs.drawPile = shuffleDeck(cardsToShuffle);
    
    // Discard pile now contains only the top card
    const topCard = gs.discardPile[0];
    gs.discardPile = [topCard];
    
    // Log the reshuffle event
    addLog('⚠️ Draw pile empty — the discard pile was reshuffled.');
    
    return true;
}

/**
 * Draw one card from the draw pile, automatically reshuffling if needed.
 * Returns the card object, or null if both piles are exhausted.
 * This is the single choke point for all card draws during gameplay.
 */
function drawOneCard(gs) {
    // If draw pile has cards, use them
    if (gs.drawPile.length > 0) {
        return gs.drawPile.shift();
    }
    
    // Draw pile is empty: attempt reshuffle
    if (reshuffleDiscardIntoDraw(gs)) {
        // Reshuffle succeeded: draw from newly populated pile
        if (gs.drawPile.length > 0) {
            return gs.drawPile.shift();
        }
    }
    
    // Both piles exhausted (or reshuffle failed): return null
    // Caller will handle fallback behavior
    return null;
}
// --- END BRANCH A ---

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
        // BRANCH C: Robo flags (false/null for human players)
        isRobo: p.isRobo || false,
        difficulty: p.difficulty || null,
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
    // BRANCH C: Reset robo card memory at the start of every round
    roboInstances.forEach(robo => robo.resetMemory());

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
function handleEndOfRound(winners) { if (!gameState || gameState.phase === 'RoundOver' || gameState.phase === 'GameOver') return; gameState.phase = 'RoundOver'; gameState.readyForNextRound = []; /* BRANCH C: robos auto-ready */ gameState.players.forEach(p => { if (p.isRobo && p.status === 'Active') gameState.readyForNextRound.push(p.playerId); }); const scoresForRound = []; gameState.players.forEach(p => { const roundScore = (p.status === 'Active' || p.status === 'Disconnected') ? calculateScore(p.hand) : 0; p.score += roundScore; p.scoresByRound.push((p.status === 'Active' || p.status === 'Disconnected') ? roundScore : '-'); scoresForRound.push({ name: p.name, roundScore: roundScore, cumulativeScore: p.score }); }); const winnerNames = winners.map(w => w.name).join(' and '); addLog(`🏁 ${winnerNames} wins the round!`); io.emit('announceRoundWinner', { winnerNames }); io.emit('roundOver', { winnerName: winnerNames, scores: scoresForRound, finalGameState: gameState }); }
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
            // BRANCH A: Use drawOneCard for automatic reshuffle if needed
            const card1 = drawOneCard(gameState);
            if (card1) player.hand.push(card1);
            const card2 = drawOneCard(gameState);
            if (card2) player.hand.push(card2);
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
        // BRANCH C: Inform all robo memories of this card play
        recordCardForRoboMemories(playedCard, player.name);
        
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
function handlePlayerRemoval(playerId) { if (!gameState) return; const player = gameState.players.find(p => p.playerId === playerId); if (player && player.status === 'Disconnected') { player.status = 'Removed'; addLog(`Player ${player.name} failed to reconnect and has been removed.`); if (player.isHost) { const nextActivePlayer = gameState.players.find(p => p.status === 'Active'); if (nextActivePlayer) { nextActivePlayer.isHost = true; addLog(`Host ${player.name} was removed. ${nextActivePlayer.name} is the new host.`); } else { addLog(`Host ${player.name} was removed. No active players left.`); } } const activePlayers = gameState.players.filter(p => p.status === 'Active'); const activeHumans = activePlayers.filter(p => !p.isRobo); /* BRANCH C */ if ((activePlayers.length < 2 || activeHumans.length === 0) && gameState.phase !== 'GameOver') { addLog('Less than 2 active players remaining (or no humans left). Game over.'); gameState.phase = 'GameOver'; const finalGamePlayers = [...gameState.players]; const lowestScore = Math.min(...finalGamePlayers.filter(p => p.status !== 'Removed').map(p => p.score)); const winners = finalGamePlayers.filter(p => p.status !== 'Removed' && p.score === lowestScore); const winnerNames = winners.map(w => w.name).join(' and '); io.emit('announceFinalWinner', { winnerNames }); setTimeout(() => { if(gameState) io.emit('finalGameOver', gameState); setTimeout(() => { players = finalGamePlayers .filter(p => p.status !== 'Removed' && !p.isRobo) /* BRANCH C: exclude robos from lobby */ .map(p => ({ playerId: p.playerId, socketId: p.socketId, name: p.name, isHost: p.isHost, isReady: p.isHost, active: true })); roboInstances.clear(); /* BRANCH C */ const hostExists = players.some(p => p.isHost); if (!hostExists && players.length > 0) { players[0].isHost = true; players[0].isReady = true; } else if (hostExists) { const host = players.find(p=>p.isHost); if(host) host.isReady = true; } gameState = null; io.emit('lobbyUpdate', players); }, 5000); }, 3000); return; } const remainingDisconnected = gameState.players.filter(p => p.status === 'Disconnected'); if (remainingDisconnected.length === 0 && gameState.isPaused) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; if (globalPauseTimeout) { clearTimeout(globalPauseTimeout); globalPauseTimeout = null; } addLog("Last disconnected player removed by timer. Game resumed."); } else if (gameState.isPaused) { gameState.pauseInfo.pausedForPlayerNames = remainingDisconnected.map(p => p.name); } const currentActivePlayer = gameState.players[gameState.currentPlayerIndex]; if (['Playing', 'ChoosingColor', 'ChoosingPickUntilAction', 'ChoosingSwapHands'].includes(gameState.phase) && currentActivePlayer?.playerId === playerId) { addLog(`It was ${player.name}'s turn. Advancing to next active player.`); if (gameState.playerChoosingActionId === playerId) { gameState.playerChoosingActionId = null; gameState.phase = 'Playing'; } advanceTurn(); } io.emit('updateGameState', gameState); } else { console.log(`handlePlayerRemoval called for ${playerId}, but player was not found or not Disconnected.`); } }


// ─────────────────────────────────────────────────────────────────────────────
// BRANCH C: Robo AI — helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inform every active RoboPlayer instance that a card was played.
 * Called once per card play from handleCardPlay.
 */
function recordCardForRoboMemories(card, playerName) {
    roboInstances.forEach(robo => robo.recordCard(card, playerName));
}

/**
 * Schedule a robo turn if the player who must act next is a Robo.
 * Idempotent — roboTurnPending flag prevents double-scheduling.
 * Safe to call after every io.emit('updateGameState').
 */
function scheduleRoboTurnIfNeeded() {
    if (!gameState || gameState.isPaused || roboTurnPending) return;
    if (['RoundOver', 'GameOver', 'Lobby'].includes(gameState.phase)) return;

    let actionPlayer = null;

    if (gameState.phase === 'Dealing') {
        // Check if the robo is the dealer for this round
        actionPlayer = gameState.players.find(
            p => p.playerId === gameState.playerChoosingActionId && p.isRobo
        ) || null;
    } else if (gameState.phase === 'Playing') {
        const cur = gameState.players[gameState.currentPlayerIndex];
        if (cur?.isRobo && cur?.status === 'Active') actionPlayer = cur;
    } else if (['ChoosingColor', 'ChoosingPickUntilAction', 'ChoosingSwapHands'].includes(gameState.phase)) {
        actionPlayer = gameState.players.find(
            p => p.playerId === gameState.playerChoosingActionId && p.isRobo
        ) || null;
    }

    if (actionPlayer) {
        roboTurnPending = true;
        setTimeout(() => {
            roboTurnPending = false;
            if (gameState && !gameState.isPaused) {
                processRoboTurn().catch(err =>
                    console.error(`[Robo] Unhandled error in processRoboTurn:`, err)
                );
            }
        }, ROBO_THINK_TIME);
    }
}

/**
 * Main robo turn processor.
 * Determines which robo must act, asks its strategy for a move,
 * executes it, and schedules the next robo turn if needed.
 */
async function processRoboTurn() {
    if (!gameState || gameState.isPaused) return;
    if (['RoundOver', 'GameOver', 'Lobby'].includes(gameState.phase)) return;

    // ── Dealing phase: robo auto-deals 7 cards ─────────────────────────────
    if (gameState.phase === 'Dealing') {
        const dealer = gameState.players.find(p => p.playerId === gameState.playerChoosingActionId);
        if (!dealer?.isRobo) return;
        addLog(`🤖 ${dealer.name} (AI Dealer) deals 7 cards.`);
        gameState.numCardsToDeal = 7;
        gameState.playerChoosingActionId = null;
        gameState = startNewRound(gameState);
        io.emit('updateGameState', gameState);
        scheduleRoboTurnIfNeeded();
        return;
    }

    // ── Determine which robo must act ──────────────────────────────────────
    let roboPlayer = null;
    let roboIndex  = -1;

    if (gameState.phase === 'Playing') {
        roboIndex  = gameState.currentPlayerIndex;
        roboPlayer = gameState.players[roboIndex];
        if (!roboPlayer?.isRobo || roboPlayer?.status !== 'Active') return;
    } else if (['ChoosingColor', 'ChoosingPickUntilAction', 'ChoosingSwapHands'].includes(gameState.phase)) {
        roboIndex  = gameState.players.findIndex(p => p.playerId === gameState.playerChoosingActionId);
        roboPlayer = gameState.players[roboIndex];
        if (!roboPlayer?.isRobo) return;
    }

    if (!roboPlayer || roboIndex === -1) return;

    const roboInstance = roboInstances.get(roboPlayer.playerId);
    if (!roboInstance) {
        console.error(`[Robo] No instance found for ${roboPlayer.name} (${roboPlayer.playerId})`);
        return;
    }

    // ── Race strategy against timeout ──────────────────────────────────────
    try {
        const movePromise    = roboInstance.makeMove(gameState, roboIndex);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Robo timeout')), ROBO_TIMEOUT)
        );
        const move = await Promise.race([movePromise, timeoutPromise]);
        executeRoboMove(roboPlayer, roboIndex, move);

    } catch (err) {
        if (err.message === 'Robo timeout') {
            addLog(`⏱️ ${roboPlayer.name} timed out — making a random move.`);
            handleRoboTimeout(roboPlayer, roboIndex);
        } else {
            console.error(`[Robo] Error in ${roboPlayer.name}'s turn:`, err);
            addLog(`❌ ${roboPlayer.name} hit an error — passing turn.`);
            if (gameState.phase === 'Playing') {
                executeDrawCard(roboIndex, () => {}, () => {});
            }
        }
    }

    // ── Emit state and check for next robo turn ────────────────────────────
    if (gameState && !['RoundOver', 'GameOver'].includes(gameState.phase)) {
        io.emit('updateGameState', gameState);
    }
    scheduleRoboTurnIfNeeded();
}

/**
 * Execute a move returned by the robo strategy.
 * @param {object} roboPlayer  - Entry in gameState.players
 * @param {number} roboIndex
 * @param {object} move        - { type, ... }
 */
function executeRoboMove(roboPlayer, roboIndex, move) {
    switch (move.type) {
        case 'playCard': {
            const player = gameState.players[roboIndex];
            // Auto-declare UNO when going from 2 cards to 1
            if (player.hand.length === 2) player.unoState = 'declared';
            handleCardPlay(roboIndex, move.cardIndex);
            break;
        }
        case 'drawCard':
            executeDrawCard(
                roboIndex,
                () => {},   // No personal announce for robo
                (event, data) => {
                    // When robo draws a playable wild, play it immediately
                    if (event === 'drawnWildCard') {
                        const player = gameState.players[roboIndex];
                        if (player.hand.length === 2) player.unoState = 'declared';
                        gameState.phase = 'Playing';
                        handleCardPlay(roboIndex, data.cardIndex);
                    }
                }
            );
            break;
        case 'chooseColor':
            executeColorChosen(roboPlayer.playerId, move.color);
            break;
        case 'pickUntilChoice':
            executePickUntilChoice(roboPlayer.playerId, move.choice);
            break;
        case 'swapHandsChoice':
            executeSwapHandsChoice(roboPlayer.playerId, move.targetPlayerId);
            break;
        default:
            console.error(`[Robo] Unknown move type: ${move.type}`);
    }
}

/**
 * Fallback when robo times out: play a random legal card, or draw.
 */
function handleRoboTimeout(roboPlayer, roboIndex) {
    const player = gameState.players[roboIndex];

    if (gameState.phase === 'Playing') {
        const topCard    = gameState.discardPile[0].card;
        const randomCard = DecisionEngine.getRandomLegalCard(
            player.hand, topCard, gameState.activeColor, gameState.drawPenalty
        );
        if (randomCard) {
            if (player.hand.length === 2) player.unoState = 'declared';
            handleCardPlay(roboIndex, randomCard.index);
        } else {
            executeDrawCard(roboIndex, () => {}, () => {});
        }
    } else if (gameState.phase === 'ChoosingColor') {
        executeColorChosen(roboPlayer.playerId, COLORS[Math.floor(Math.random() * COLORS.length)]);
    } else if (gameState.phase === 'ChoosingPickUntilAction') {
        executePickUntilChoice(roboPlayer.playerId, 'pick-color');
    } else if (gameState.phase === 'ChoosingSwapHands') {
        const others = gameState.players.filter((p, i) => i !== roboIndex && p.status === 'Active');
        if (others.length > 0) {
            executeSwapHandsChoice(roboPlayer.playerId, others[0].playerId);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH C: Execute functions — extracted game logic, no socket dependency.
// Socket handlers become thin wrappers; robo calls these directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core draw logic. Extracted from the drawCard socket handler.
 * @param {number}   playerIndex
 * @param {function} personalAnnounce  - fn(msg) sends to individual player's socket
 * @param {function} personalEmit      - fn(event, data) emits to individual player's socket
 * @returns {boolean} true = early return (caller should NOT broadcast state yet)
 */
function executeDrawCard(playerIndex, personalAnnounce, personalEmit) {
    const player  = gameState.players[playerIndex];
    const isRobo  = player.isRobo;
    const topCard = gameState.discardPile[0].card;

    // ── 1. Draw penalty (Draw Two / Wild Draw Four) ──────────────────────────
    if (gameState.drawPenalty > 0) {
        const penalty = gameState.drawPenalty;
        let cardsDrawn = 0;
        for (let i = 0; i < penalty; i++) {
            const card = drawOneCard(gameState);
            if (card) { player.hand.push(card); cardsDrawn++; }
        }
        io.emit('animateDraw', { playerId: player.playerId, count: cardsDrawn });
        addLog(`› ${player.name} drew ${penalty} cards.`);
        player.unoState = 'safe';
        gameState.drawPenalty = 0;
        if (gameState.pickUntilState?.active && gameState.pickUntilState.targetPlayerIndex === playerIndex) {
            addLog(`...and the 'Pick Until ${gameState.pickUntilState.targetColor}' action was cancelled.`);
            gameState.pickUntilState = null;
        }
        if (gameState.winnerOnHold.length > 0) {
            const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
            if (!heldWinners.some(w => w.playerId === player.playerId)) {
                handleEndOfRound(heldWinners); return true;
            } else { gameState.winnerOnHold = []; }
        }
        advanceTurn();
        gameState.phase = 'Playing';
        return false;
    }

    // ── 2. Pick Until ─────────────────────────────────────────────────────────
    if (gameState.pickUntilState?.active && gameState.pickUntilState.targetPlayerIndex === playerIndex) {
        const drawnCard = drawOneCard(gameState);
        if (drawnCard) {
            player.hand.push(drawnCard);
            io.emit('animateDraw', { playerId: player.playerId, count: 1 });
            addLog(`› ${player.name} is picking for a ${gameState.pickUntilState.targetColor}...`);
            if (drawnCard.color === gameState.pickUntilState.targetColor) {
                player.hand.splice(player.hand.findIndex(c => c === drawnCard), 1);
                gameState.discardPile.unshift({ card: drawnCard, playerName: player.name });
                recordCardForRoboMemories(drawnCard, player.name);
                gameState.activeColor = drawnCard.color;
                personalAnnounce(`You drew the target color (${drawnCard.value} ${drawnCard.color}) and it was played for you.`);
                addLog(`...and it was a playable ${drawnCard.color} ${drawnCard.value}!`);
                const pickUntilChooserId = gameState.pickUntilState.chooserPlayerId;
                gameState.pickUntilState = null;
                if (player.hand.length === 0) {
                    const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
                    handleEndOfRound([player, ...heldWinners]); return true;
                }
                if (gameState.winnerOnHold.includes(pickUntilChooserId)) {
                    const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
                    handleEndOfRound(heldWinners); return true;
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
            gameState.pickUntilState = null;
            advanceTurn();
            gameState.phase = 'Playing';
        }
        return false;
    }

    // ── 3. Normal draw ────────────────────────────────────────────────────────
    if (checkIfPlayerMustPlay(player, topCard, gameState.activeColor)) {
        personalAnnounce('You have a playable card in your hand. You must play it.');
        return true; // Early return: don't change state, don't broadcast
    }

    const drawnCard = drawOneCard(gameState);
    if (drawnCard) {
        io.emit('animateDraw', { playerId: player.playerId, count: 1 });

        if (isMoveValid(drawnCard, topCard, gameState.activeColor, 0)) {
            if (drawnCard.color === 'Black') {
                // Playable Wild drawn
                player.hand.push(drawnCard);
                const cardIndex = player.hand.length - 1;
                if (isRobo) {
                    // Robo plays drawn wild immediately (no modal)
                    if (player.hand.length === 2) player.unoState = 'declared';
                    gameState.phase = 'Playing';
                    handleCardPlay(playerIndex, cardIndex);
                } else {
                    // Human: show modal and wait for choosePlayDrawnWild
                    personalEmit('updateGameState', gameState);
                    personalEmit('drawnWildCard', { cardIndex, drawnCard });
                }
                return !isRobo; // Human → early return; Robo → continue to emit
            } else {
                // Auto-play non-Wild drawn card
                const willAutoUno = player.hand.length === 1;
                gameState.discardPile.unshift({ card: drawnCard, playerName: player.name });
                recordCardForRoboMemories(drawnCard, player.name);
                gameState.activeColor = drawnCard.color;
                applyCardEffect(drawnCard);
                personalAnnounce(`You drew a playable card (${drawnCard.value} ${drawnCard.color}) and it was played for you.`);
                addLog(`...and it was a playable ${drawnCard.color} ${drawnCard.value}!`);
                player.unoState = 'safe';
                if (willAutoUno) { io.emit('unoCalled', { playerName: player.name }); }
                const numActivePlayers = gameState.players.filter(p => p.status === 'Active').length;
                if (drawnCard.value === 'Skip' || (drawnCard.value === 'Reverse' && numActivePlayers === 2)) { advanceTurn(); }
                advanceTurn();
                gameState.phase = 'Playing';
            }
        } else {
            // Card not playable — add to hand and pass
            player.hand.push(drawnCard);
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
    return false;
}

/**
 * Color choice logic. Extracted from the colorChosen socket handler.
 * No socket-specific emits — all io.emit calls broadcast to everyone.
 */
function executeColorChosen(playerId, color) {
    const choosingPlayer = gameState.players.find(p => p.playerId === playerId);
    if (!choosingPlayer || gameState.playerChoosingActionId !== choosingPlayer.playerId) return;

    addLog(`🎨 ${choosingPlayer.name} chose the color ${color}.`);
    gameState.activeColor = color;
    const wasDealerChoosingFirstCard =
        gameState.discardPile.length === 1 &&
        gameState.players[gameState.dealerIndex].playerId === choosingPlayer.playerId;

    if (gameState.swapState) {
        gameState.phase = 'ChoosingSwapHands';
    } else if (gameState.pickUntilState) {
        gameState.pickUntilState.active      = true;
        gameState.pickUntilState.targetColor = color;
        gameState.currentPlayerIndex         = gameState.pickUntilState.targetPlayerIndex;
        const targetPlayer = gameState.players[gameState.pickUntilState.targetPlayerIndex];
        const msg = `› ${targetPlayer.name} must now pick until they find a ${color} card!`;
        addLog(msg);
        io.emit('announce', msg);
        gameState.phase = 'Playing';
        gameState.playerChoosingActionId = null;
    } else {
        const playedCard = gameState.discardPile[0]?.card;
        if (!wasDealerChoosingFirstCard && playedCard) {
            let announceMsg = '';
            if (playedCard.value === 'Wild Draw Four')       announceMsg = `✨ ${choosingPlayer.name} played Wild Draw Four and chose ${color}.`;
            else if (playedCard.value === 'Wild')            announceMsg = `✨ ${choosingPlayer.name} played Wild and chose ${color}.`;
            else                                             announceMsg = `✨ ${choosingPlayer.name} chose ${color}.`;
            io.emit('announce', announceMsg);
        }
        if (!wasDealerChoosingFirstCard) { advanceTurn(); }
        gameState.phase = 'Playing';
        gameState.playerChoosingActionId = null;
    }
}

/**
 * Pick Until action choice logic. Extracted from the pickUntilChoice socket handler.
 * Uses playerId (not socket.id) to correctly identify self for all player types.
 */
function executePickUntilChoice(playerId, choice) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (!player || gameState.playerChoosingActionId !== player.playerId) return;

    const originalPlayerIndex = gameState.players.findIndex(p => p.playerId === playerId);
    const numPlayers = gameState.players.length;

    if (choice === 'discard-wilds') {
        const msg = `🌪️ ${player.name} chose 'All players discard Wilds'!`;
        addLog(msg); io.emit('announce', msg);
        const winners = [];
        const allDiscardedData = [];
        gameState.players.forEach(p => {
            if (p.playerId !== playerId && p.status === 'Active') {
                const origSize = p.hand.length;
                if (origSize > 0) {
                    const discarded = p.hand.filter(c => c.color === 'Black');
                    if (discarded.length > 0) allDiscardedData.push({ playerName: p.name, cards: discarded });
                    p.hand = p.hand.filter(c => c.color !== 'Black');
                    if (p.hand.length === 0) winners.push(p);
                    else if (p.hand.length === 1 && origSize > 1) {
                        p.unoState = 'declared';
                        io.emit('unoCalled', { playerName: p.name });
                    }
                }
            }
        });
        io.emit('showDiscardWildsModal', allDiscardedData);
        if (allDiscardedData.length === 0) addLog('...but no other players had any Wild cards.');
        if (winners.length > 0) {
            const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
            handleEndOfRound([...winners, ...heldWinners]); return;
        }
        if (gameState.winnerOnHold.includes(player.playerId)) {
            const heldWinners = gameState.players.filter(p => gameState.winnerOnHold.includes(p.playerId));
            handleEndOfRound(heldWinners); return;
        }
        gameState.phase = 'ChoosingColor';

    } else if (choice === 'pick-color') {
        const msg = `🎨 ${player.name} chose 'Next player picks until color'.`;
        addLog(msg); io.emit('announce', msg);
        let nextPlayerIndex = -1;
        let searchIndex = originalPlayerIndex;
        let searchLimit = numPlayers;
        do {
            searchIndex = (searchIndex + gameState.playDirection + numPlayers) % numPlayers;
            if (gameState.players[searchIndex].status === 'Active') { nextPlayerIndex = searchIndex; break; }
            searchLimit--;
        } while (searchLimit > 0);

        if (nextPlayerIndex !== -1 && nextPlayerIndex !== originalPlayerIndex) {
            gameState.pickUntilState = {
                chooserPlayerId: player.playerId,
                targetPlayerIndex: nextPlayerIndex,
                active: false,
                targetColor: null
            };
        } else {
            addLog('No other active players to target. Turn continues after color choice.');
            gameState.pickUntilState = null;
        }
        gameState.phase = 'ChoosingColor';
    }
}

/**
 * Swap hands choice logic. Extracted from the swapHandsChoice socket handler.
 */
function executeSwapHandsChoice(playerId, targetPlayerId) {
    const choosingPlayer = gameState.players.find(p => p.playerId === playerId);
    if (!choosingPlayer || gameState.playerChoosingActionId !== choosingPlayer.playerId) return;

    const targetPlayer = gameState.players.find(p => p.playerId === targetPlayerId && p.status === 'Active');
    if (choosingPlayer && targetPlayer) {
        io.emit('animateSwap', { p1_id: choosingPlayer.playerId, p2_id: targetPlayer.playerId });
        [choosingPlayer.hand, targetPlayer.hand] = [targetPlayer.hand, choosingPlayer.hand];
        [choosingPlayer, targetPlayer].forEach(p => {
            if (p.hand.length === 1) { p.unoState = 'declared'; io.emit('unoCalled', { playerName: p.name }); }
            else { p.unoState = 'safe'; }
        });
        const msg = `🤝 ${choosingPlayer.name} swapped hands with ${targetPlayer.name}!`;
        addLog(msg); io.emit('announce', msg);
        gameState.playerChoosingActionId = null;
        gameState.swapState = null;
        advanceTurn();
        gameState.phase = 'Playing';
    } else {
        addLog(`Target player ${targetPlayerId} not found or not active.`);
        gameState.phase = 'Playing';
        advanceTurn();
    }
}

/**
 * Choose-play-drawn-wild logic. Extracted from the choosePlayDrawnWild socket handler.
 */
function executeChoosePlayDrawnWild(playerIndex, play, cardIndex) {
    const player = gameState.players[playerIndex];
    if (!player || playerIndex !== gameState.currentPlayerIndex) return;

    if (play) {
        if (cardIndex !== player.hand.length - 1) { console.error('[Robo] Drawn wild card index mismatch!'); return; }
        if (player.hand.length === 2) { player.unoState = 'declared'; }
        gameState.phase = 'Playing';
        handleCardPlay(playerIndex, cardIndex);
    } else {
        addLog(`› ${player.name} drew a card.`);
        advanceTurn();
        gameState.phase = 'Playing';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// END BRANCH C helper functions
// ─────────────────────────────────────────────────────────────────────────────

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

    // BRANCH C: Prompt host to configure AI players
    socket.emit('showRoboConfig');
  });
  // --- *** END NEW HANDLER *** ---


  // --- BRANCH C: addRobos handler ---
  socket.on('addRobos', ({ roboConfigs }) => {
    if (gameState) return; // Game already started
    const host = players.find(p => p.socketId === socket.id && p.isHost);
    if (!host) return socket.emit('announce', 'Only the host can configure AI players.');

    // Validate and clamp count
    if (!Array.isArray(roboConfigs)) return;
    const validConfigs = roboConfigs.slice(0, 8).filter(c => c && typeof c === 'object');

    // Remove all existing robos (clean replace)
    const existingRoboIds = players.filter(p => p.isRobo).map(p => p.playerId);
    existingRoboIds.forEach(id => roboInstances.delete(id));
    players = players.filter(p => !p.isRobo);

    const VALID_DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert'];

    validConfigs.forEach((config, i) => {
        const roboId   = `robo-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 4)}`;
        const roboName = (config.name || `Robo${i + 1}`).trim().slice(0, 20) || `Robo${i + 1}`;
        const difficulty = VALID_DIFFICULTIES.includes(config.difficulty) ? config.difficulty : 'Normal';

        // Create the RoboPlayer instance (holds strategy + memory)
        const roboInstance = new RoboPlayer(roboId, roboName, difficulty);
        roboInstances.set(roboId, roboInstance);

        // Add a lightweight lobby entry (no real socket)
        players.push({
            playerId:   roboId,
            socketId:   `robo-socket-${roboId}`,
            name:       roboName,
            isHost:     false,
            isReady:    true,  // Robos are always ready
            active:     true,
            isRobo:     true,
            difficulty: difficulty,
        });
    });

    console.log(`[Robo] ${validConfigs.length} AI player(s) added to lobby by host ${host.name}.`);
    io.emit('lobbyUpdate', players);
  });
  // --- END BRANCH C addRobos handler ---

  socket.on('setPlayerReady', () => { if (gameState) return; const player = players.find(p => p.socketId === socket.id); if (player && !player.isHost) { player.isReady = !player.isReady; io.emit('lobbyUpdate', players); } });
  socket.on('kickPlayer', ({ playerIdToKick }) => {
    if (gameState) return;
    const host = players.find(p => p.socketId === socket.id && p.isHost);
    if (host) {
      const playerToKick = players.find(p => p.playerId === playerIdToKick);
      if (playerToKick) {
        console.log(`Host ${host.name} kicked ${playerToKick.name}`);
        players = players.filter(player => player.playerId !== playerIdToKick);
        if (playerToKick.isRobo) {
          // BRANCH C: Robo has no socket — clean up instance only
          roboInstances.delete(playerIdToKick);
        } else {
          io.to(playerToKick.socketId).emit('forceDisconnect');
        }
        io.emit('lobbyUpdate', players);
      }
    }
  });
  
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
    scheduleRoboTurnIfNeeded(); // BRANCH C: in case dealer is a robo
  });
  // --- *** END MODIFIED startGame *** ---

  function checkAndStartNextRound() { if (!gameState || gameState.phase !== 'RoundOver') return; const host = gameState.players.find(p => p.isHost); const connectedPlayers = gameState.players.filter(p => p.status === 'Active'); if (!host) return; const hostIsReady = gameState.readyForNextRound.includes(host.playerId); const allPlayersReady = gameState.readyForNextRound.length === connectedPlayers.length; if (hostIsReady && allPlayersReady) { let newDealerIndex = (gameState.dealerIndex + 1) % gameState.players.length; let maxAttempts = gameState.players.length; while (gameState.players[newDealerIndex].status !== 'Active' && maxAttempts > 0) { addLog(`Dealer ${gameState.players[newDealerIndex].name} is not active. Skipping.`); newDealerIndex = (newDealerIndex + 1) % gameState.players.length; maxAttempts--; } if (gameState.players[newDealerIndex].status !== 'Active') { addLog("Error: No active player found to be the next dealer!"); return; } gameState.dealerIndex = newDealerIndex; const dealer = gameState.players[newDealerIndex]; gameState.playerChoosingActionId = dealer.playerId; gameState.phase = 'Dealing'; io.emit('updateGameState', gameState); scheduleRoboTurnIfNeeded(); /* BRANCH C */ } }
  socket.on('playerReadyForNextRound', () => { if (!gameState || gameState.phase !== 'RoundOver') return; const player = gameState.players.find(p => p.socketId === socket.id); if (player && player.status === 'Active' && !gameState.readyForNextRound.includes(player.playerId)) { gameState.readyForNextRound.push(player.playerId); checkAndStartNextRound(); io.emit('updateGameState', gameState); } });
  socket.on('dealChoice', ({ numCards }) => { if (!gameState || gameState.phase !== 'Dealing' || gameState.isPaused) return; const dealingPlayer = gameState.players.find(p => p.socketId === socket.id); if (gameState.playerChoosingActionId === dealingPlayer?.playerId) { const numToDeal = Math.max(1, Math.min(13, parseInt(numCards) || 7)); gameState.numCardsToDeal = numToDeal; gameState.playerChoosingActionId = null; gameState = startNewRound(gameState); io.emit('updateGameState', gameState); scheduleRoboTurnIfNeeded(); /* BRANCH C */ } });
  socket.on('endGame', () => { const player = (gameState ? gameState.players.find(p => p.socketId === socket.id) : null) || players.find(p => p.socketId === socket.id); if (player && player.isHost) { if (gameState && gameState.phase !== 'GameOver') { addLog(`The game has been ended early by the host.`); gameState.phase = 'GameOver'; const finalGamePlayers = [...gameState.players]; const lowestScore = Math.min(...finalGamePlayers.filter(p => p.status !== 'Removed').map(p => p.score)); const winners = finalGamePlayers.filter(p => p.status !== 'Removed' && p.score === lowestScore); const winnerNames = winners.map(w => w.name).join(' and '); io.emit('announceFinalWinner', { winnerNames }); if (gameOverToLobbyTimer) clearTimeout(gameOverToLobbyTimer); if (scoresToLobbyTimer) clearTimeout(scoresToLobbyTimer); gameOverToLobbyTimer = setTimeout(() => { if (!gameState) return; io.emit('finalGameOver', gameState); scoresToLobbyTimer = setTimeout(() => { if (!gameState && !players.length) return; players = finalGamePlayers .filter(p => p.status !== 'Removed' && !p.isRobo) /* BRANCH C: exclude robos from lobby */ .map(p => ({ playerId: p.playerId, socketId: p.socketId, name: p.name, isHost: p.isHost, isReady: p.isHost, active: true })); roboInstances.clear(); /* BRANCH C */ const hostExists = players.some(p => p.isHost); if (!hostExists && players.length > 0) { players[0].isHost = true; players[0].isReady = true; } else if (hostExists) { const host = players.find(p=>p.isHost); if(host) host.isReady = true; } gameState = null; io.emit('lobbyUpdate', players); }, 15000); }, 3000); } else if (!gameState) { players.forEach(p => p.isReady = p.isHost); io.emit('lobbyUpdate', players); } } });
  socket.on('hardReset', () => { 
    const host = (gameState ? gameState.players.find(p => p.socketId === socket.id && p.isHost) : null) || players.find(p => p.socketId === socket.id && p.isHost); 
    if (host) { 
      console.log(`Host ${host.name} initiated HARD RESET.`); 
      const currentPlayers = gameState ? gameState.players : players; 
      currentPlayers.forEach(p => { 
        if (p.socketId !== host.socketId) { 
          io.to(p.socketId).emit('forceDisconnect'); 
        } 
      }); 
      gameState = null; 
      
      // --- BRANCH B: Fix timer clearing (removed undefined reconnectTimers reference) ---
      if (globalPauseTimeout) clearTimeout(globalPauseTimeout);
      globalPauseTimeout = null;
      
      if (gameOverToLobbyTimer) clearTimeout(gameOverToLobbyTimer);
      gameOverToLobbyTimer = null;
      
      if (scoresToLobbyTimer) clearTimeout(scoresToLobbyTimer);
      scoresToLobbyTimer = null;
      // --- END BRANCH B ---
      
      // BRANCH C: Clear robo state
      roboInstances.clear();
      roboTurnPending = false;
      
      const hostData = currentPlayers.find(p => p.playerId === host.playerId); 
      players = [{ playerId: hostData.playerId, socketId: host.socketId, name: hostData.name, isHost: true, isReady: true, active: true }]; 
      io.emit('lobbyUpdate', players); 
    } 
  });
  socket.on('playCard', ({ cardIndex }) => { if (!gameState || gameState.phase !== 'Playing' || gameState.isPaused) return; const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id); if (playerIndex !== -1) { handleCardPlay(playerIndex, cardIndex); if (gameState && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') { io.emit('updateGameState', gameState); scheduleRoboTurnIfNeeded(); /* BRANCH C */ } } });
  
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
  
  // --- *** drawCard handler — delegates to executeDrawCard *** ---
  socket.on('drawCard', () => {
    if (!gameState || !['Playing'].includes(gameState.phase) || gameState.isPaused) return;
    const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === gameState.currentPlayerIndex) {
        // BRANCH C: Delegate to extracted execute function with socket-specific callbacks
        const earlyExit = executeDrawCard(
            playerIndex,
            (msg)         => io.to(socket.id).emit('announce', msg),
            (event, data) => io.to(socket.id).emit(event, data)
        );
        // Broadcast state unless we returned early (must-play check or waiting for wild choice)
        if (!earlyExit && gameState && gameState.phase !== 'GameOver' && gameState.phase !== 'RoundOver') {
            io.emit('updateGameState', gameState);
            scheduleRoboTurnIfNeeded(); /* BRANCH C */
        }
    }
  });
  // --- *** END drawCard *** ---

  socket.on('choosePlayDrawnWild', ({ play, cardIndex }) => { 
      if (!gameState || !['Playing'].includes(gameState.phase) || gameState.isPaused) return; 
      const playerIndex = gameState.players.findIndex(p => p.socketId === socket.id); 
      if (playerIndex === -1) return;
      // BRANCH C: Delegate to extracted execute function
      executeChoosePlayDrawnWild(playerIndex, play, cardIndex);
      if (gameState && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') { 
          io.emit('updateGameState', gameState);
          scheduleRoboTurnIfNeeded(); /* BRANCH C */
      } 
  });
  socket.on('pickUntilChoice', ({ choice }) => {
    if (!gameState || gameState.phase !== 'ChoosingPickUntilAction' || gameState.isPaused) return;
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (gameState.playerChoosingActionId !== player?.playerId) return;
    // BRANCH C: Delegate to extracted execute function (uses playerId not socketId)
    executePickUntilChoice(player.playerId, choice);
    if (gameState && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') {
        io.emit('updateGameState', gameState);
        scheduleRoboTurnIfNeeded(); /* BRANCH C */
    }
  });
  socket.on('swapHandsChoice', ({ targetPlayerId }) => {
    if (!gameState || gameState.phase !== 'ChoosingSwapHands' || gameState.isPaused) return;
    const choosingPlayer = gameState.players.find(p => p.socketId === socket.id);
    if (gameState.playerChoosingActionId !== choosingPlayer?.playerId) return;
    // BRANCH C: Delegate to extracted execute function
    executeSwapHandsChoice(choosingPlayer.playerId, targetPlayerId);
    io.emit('updateGameState', gameState);
    scheduleRoboTurnIfNeeded(); /* BRANCH C */
  });
  socket.on('colorChosen', ({ color }) => {
    if (!gameState || gameState.phase !== 'ChoosingColor' || gameState.isPaused) return;
    const choosingPlayer = gameState.players.find(p => p.socketId === socket.id);
    if (gameState.playerChoosingActionId !== choosingPlayer?.playerId) return;
    // BRANCH C: Delegate to extracted execute function
    executeColorChosen(choosingPlayer.playerId, color);
    io.emit('updateGameState', gameState);
    scheduleRoboTurnIfNeeded(); /* BRANCH C */
  });
  socket.on('rearrangeHand', ({ newHand }) => { if (!gameState) return; const player = gameState.players.find(p => p.socketId === socket.id); if (player) { if (newHand.length === player.hand.length) { player.hand = newHand; } } });
  socket.on('markPlayerAFK', ({ playerIdToMark }) => { if (!gameState || ['Lobby', 'GameOver'].includes(gameState.phase)) return; const host = gameState.players.find(p => p.socketId === socket.id && p.isHost); const playerToMark = gameState.players.find(p => p.playerId === playerIdToMark); if (host && playerToMark && playerToMark.status === 'Active') { playerToMark.status = 'Disconnected'; addLog(`Host ${host.name} marked ${playerToMark.name} as AFK. Game pause timer updated/started.`); gameState.isPaused = true; const newPauseEndTime = Date.now() + DISCONNECT_GRACE_PERIOD; gameState.pauseInfo.pauseEndTime = newPauseEndTime; gameState.pauseInfo.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name); if (globalPauseTimeout) clearTimeout(globalPauseTimeout); globalPauseTimeout = setTimeout(() => { if (gameState && gameState.isPaused && Date.now() >= gameState.pauseInfo.pauseEndTime) { console.log(`Global pause timer expired at ${new Date()}. Checking for removals.`); const playersToRemove = gameState.players.filter(p => p.status === 'Disconnected'); playersToRemove.forEach(p => { handlePlayerRemoval(p.playerId); }); if (gameState && !gameState.players.some(p => p.status === 'Disconnected')) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; console.log("All disconnected players removed by timer, resuming game."); io.emit('updateGameState', gameState); } } globalPauseTimeout = null; }, DISCONNECT_GRACE_PERIOD + 1000); io.to(playerToMark.socketId).emit('youWereMarkedAFK'); io.emit('updateGameState', gameState); } });
  socket.on('playerIsBack', () => { if (!gameState || gameState.phase === 'GameOver') return; const player = gameState.players.find(p => p.socketId === socket.id); if (player && player.status === 'Disconnected') { player.status = 'Active'; addLog(`Player ${player.name} is back!`); const stillDisconnected = gameState.players.filter(p => p.status === 'Disconnected'); if (stillDisconnected.length === 0 && gameState.isPaused) { gameState.isPaused = false; gameState.pauseInfo = { pauseEndTime: null, pausedForPlayerNames: [] }; if (globalPauseTimeout) { clearTimeout(globalPauseTimeout); globalPauseTimeout = null; console.log("All players back, clearing global pause timer."); } addLog("All players are back. Game resumed."); } else if (gameState.isPaused) { gameState.pauseInfo.pausedForPlayerNames = stillDisconnected.map(p => p.name); console.log(`Player ${player.name} back, but others still disconnected. Timer continues.`); } io.emit('updateGameState', gameState); scheduleRoboTurnIfNeeded(); /* BRANCH C: game may have resumed with robo's turn */ } });

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