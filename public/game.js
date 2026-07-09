window.addEventListener('DOMContentLoaded', () => {
    const socket = io(); // Assuming server is on the same origin
    // const socket = io('https://gupteg-uno-game.onrender.com'); // Use this for production

    let myPersistentPlayerId = sessionStorage.getItem('unoPlayerId');
    let isGameOver = false;
    let countdownInterval = null;
    let playerIdToMarkAFK = null;

    let previousGameState = null; // For move announcement diff
    let rainInterval = null; // Timer for rain animation

    // --- SCREEN & ELEMENT REFERENCES ---
    const joinScreen = document.getElementById('join-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const gameBoard = document.getElementById('game-board');
    const playerNameInput = document.getElementById('player-name-input');
    const joinGameBtn = document.getElementById('join-game-btn');
    const playerList = document.getElementById('player-list');
    const startGameBtn = document.getElementById('start-game-btn');
    const hostMessage = document.getElementById('host-message');
    const drawCardBtn = document.getElementById('drawCardBtn');
    const unoBtn = document.getElementById('unoBtn');
    const colorPickerModal = document.getElementById('color-picker-modal');
    const drawnWildModal = document.getElementById('drawn-wild-modal');
    const pickUntilModal = document.getElementById('pick-until-modal');
    const swapModal = document.getElementById('swap-modal');
    const endGameBtn = document.getElementById('endGameBtn');
    const endOfRoundDiv = document.getElementById('end-of-round-div');
    const nextRoundBtn = document.getElementById('next-round-btn');
    const endGameRoundBtn = document.getElementById('end-game-round-btn');
    const dealChoiceModal = document.getElementById('deal-choice-modal');
    const dealCardsInput = document.getElementById('deal-cards-input');
    const dealCardsBtn = document.getElementById('deal-cards-btn');
    const unoAnnouncementOverlay = document.getElementById('uno-announcement-overlay');
    const unoAnnouncementText = document.getElementById('uno-announcement-text');
    const confirmEndGameModal = document.getElementById('confirm-end-game-modal');
    const confirmEndYesBtn = document.getElementById('confirm-end-yes-btn');
    const confirmEndNoBtn = document.getElementById('confirm-end-no-btn');
    const finalScoreModal = document.getElementById('final-score-modal');
    const finalWinnerMessage = document.getElementById('final-winner-message');
    const finalScoreTableContainer = document.getElementById('final-score-table-container');
    const finalScoreOkBtn = document.getElementById('final-score-ok-btn');
    const invalidMoveCallout = document.getElementById('invalid-move-callout');
    const toastNotification = document.getElementById('toast-notification'); // This is the BIG alert/move toast
    const actionBar = document.getElementById('action-bar');
    const arrangeHandBtn = document.getElementById('arrangeHandBtn');
    const hostRoundEndControls = document.getElementById('host-round-end-controls');
    const nextRoundOkBtn = document.getElementById('next-round-ok-btn');
    const afkNotificationModal = document.getElementById('afk-notification-modal');
    const imBackBtn = document.getElementById('im-back-btn');
    const showDiscardPileBtn = document.getElementById('showDiscardPileBtn');
    const discardPileModal = document.getElementById('discard-pile-modal');
    const discardPileList = document.getElementById('discard-pile-list');
    const discardPileOkBtn = document.getElementById('discard-pile-ok-btn');
    const confirmAfkModal = document.getElementById('confirm-afk-modal');
    const confirmAfkPlayerName = document.getElementById('confirm-afk-player-name');
    const confirmAfkYesBtn = document.getElementById('confirm-afk-yes-btn');
    const confirmAfkNoBtn = document.getElementById('confirm-afk-no-btn');
    const discardWildsModal = document.getElementById('discard-wilds-modal');
    const discardWildsResults = document.getElementById('discard-wilds-results');
    const discardWildsOkBtn = document.getElementById('discard-wilds-ok-btn');
    const readyBtn = document.getElementById('ready-btn');
    const playerLobbyActions = document.getElementById('player-lobby-actions');
    const hostLobbyActions = document.getElementById('host-lobby-actions');
    
    // --- *** MODIFIED: Removed old password input, added new ones *** ---
    // const hostPasswordInput = document.getElementById('host-password-input'); // This is removed from host-controls
    const claimHostSection = document.getElementById('claim-host-section');
    const claimHostPasswordInput = document.getElementById('claim-host-password-input'); // This ID must match index.html
    const claimHostBtn = document.getElementById('claim-host-btn');
    // --- *** END MODIFICATION *** ---

    const hardResetBtn = document.getElementById('hard-reset-btn');
    const confirmHardResetModal = document.getElementById('confirm-hard-reset-modal');
    const confirmResetYesBtn = document.getElementById('confirm-reset-yes-btn');
    const confirmResetNoBtn = document.getElementById('confirm-reset-no-btn');
    const lobbyWaitMessage = document.getElementById('lobby-wait-message'); // Get wait message element
    const showLogBtn = document.getElementById('show-log-btn');
    const gameLogModal = document.getElementById('game-log-modal');
    const gameLogModalContent = document.getElementById('game-log-modal-content');
    const gameLogOkBtn = document.getElementById('game-log-ok-btn');


    joinScreen.style.display = 'block';
    lobbyScreen.style.display = 'none';
    gameBoard.style.display = 'none';

    // --- DRAG AND DROP GLOBALS ---
    let draggedCardElement = null;
    let draggedCardIndex = -1;

    // --- EVENT LISTENERS (Sending messages to server) ---

    joinGameBtn.addEventListener('click', () => { const playerName = playerNameInput.value.trim(); if (playerName) { sessionStorage.setItem('unoPlayerName', playerName); socket.emit('joinGame', { playerName, playerId: myPersistentPlayerId }); } else { alert('Please enter your name.'); } });
    playerList.addEventListener('click', (event) => { if (event.target.classList.contains('kick-btn')) { const playerIdToKick = event.target.dataset.playerId; socket.emit('kickPlayer', { playerIdToKick }); } });
    document.getElementById('left-column').addEventListener('click', (event) => { if (event.target.classList.contains('mark-afk-btn')) { playerIdToMarkAFK = event.target.dataset.playerId; const player = window.gameState?.players.find(p => p.playerId === playerIdToMarkAFK); if (player) { confirmAfkPlayerName.textContent = player.name; confirmAfkModal.style.display = 'flex'; } } });
    confirmAfkYesBtn.addEventListener('click', () => { if (playerIdToMarkAFK) { socket.emit('markPlayerAFK', { playerIdToMark: playerIdToMarkAFK }); } confirmAfkModal.style.display = 'none'; playerIdToMarkAFK = null; });
    confirmAfkNoBtn.addEventListener('click', () => { confirmAfkModal.style.display = 'none'; playerIdToMarkAFK = null; });
    imBackBtn.addEventListener('click', () => { socket.emit('playerIsBack'); afkNotificationModal.style.display = 'none'; });

    startGameBtn.addEventListener('click', () => {
        // *** MODIFIED: Password is no longer sent here ***
        socket.emit('startGame', {});
    });

    readyBtn.addEventListener('click', () => {
        socket.emit('setPlayerReady');
    });

    // *** NEW EVENT LISTENER ***
    claimHostBtn.addEventListener('click', () => {
        const password = claimHostPasswordInput.value; // This was the line causing the error
        socket.emit('claimHost', { password: password });
    });
    // *** END NEW LISTENER ***

    hardResetBtn.addEventListener('click', () => {
        confirmHardResetModal.style.display = 'flex';
    });
    confirmResetYesBtn.addEventListener('click', () => {
        confirmHardResetModal.style.display = 'none';
        socket.emit('hardReset');
    });
    confirmResetNoBtn.addEventListener('click', () => {
        confirmHardResetModal.style.display = 'none';
    });


    drawCardBtn.addEventListener('click', () => { if (playerHasPlayableNonWildCard(window.gameState)) { showToast('You have a playable card in your hand. You must play it.'); return; } socket.emit('drawCard'); });
    endGameBtn.addEventListener('click', () => { confirmEndGameModal.style.display = 'flex'; });
    endGameRoundBtn.addEventListener('click', () => { confirmEndGameModal.style.display = 'flex'; });
    confirmEndNoBtn.addEventListener('click', () => { confirmEndGameModal.style.display = 'none'; });

    confirmEndYesBtn.addEventListener('click', () => {
        confirmEndGameModal.style.display = 'none';
        socket.emit('endGame');
    });

    finalScoreOkBtn.addEventListener('click', () => {
        finalScoreOkBtn.disabled = true; // Disable button
        if (lobbyWaitMessage) {
            lobbyWaitMessage.textContent = "Please wait while you are taken to the Lobby...";
            lobbyWaitMessage.style.display = 'block'; // Show message
        }
        isGameOver = false; // Allow lobby rendering later
    });

    unoBtn.addEventListener('click', () => { socket.emit('callUno'); unoBtn.classList.add('pressed'); setTimeout(() => unoBtn.classList.remove('pressed'), 300); });
    nextRoundBtn.addEventListener('click', () => { socket.emit('playerReadyForNextRound'); nextRoundBtn.disabled = true; nextRoundBtn.textContent = 'Waiting...'; });
    nextRoundOkBtn.addEventListener('click', () => { socket.emit('playerReadyForNextRound'); nextRoundOkBtn.disabled = true; nextRoundOkBtn.textContent = 'Waiting for Host...'; });
    dealCardsBtn.addEventListener('click', () => { const numCards = dealCardsInput.value; socket.emit('dealChoice', { numCards }); });
    colorPickerModal.addEventListener('click', (event) => { if (event.target.matches('.color-btn')) { const color = event.target.dataset.color; socket.emit('colorChosen', { color }); } });
    drawnWildModal.addEventListener('click', (event) => { const cardIndex = parseInt(drawnWildModal.dataset.cardIndex); if (event.target.id === 'option-play-wild') { socket.emit('choosePlayDrawnWild', { play: true, cardIndex }); } else if (event.target.id === 'option-keep-wild') { socket.emit('choosePlayDrawnWild', { play: false, cardIndex }); } drawnWildModal.style.display = 'none'; });
    pickUntilModal.addEventListener('click', (event) => { let choice = null; if (event.target.id === 'option-pick-color') { choice = 'pick-color'; } else if (event.target.id === 'option-discard-wilds') { choice = 'discard-wilds'; } if (choice) { socket.emit('pickUntilChoice', { choice }); } pickUntilModal.style.display = 'none'; });
    swapModal.addEventListener('click', (event) => { if (event.target.matches('.player-swap-btn')) { const targetPlayerId = event.target.dataset.playerId; socket.emit('swapHandsChoice', { targetPlayerId }); swapModal.style.display = 'none'; } });
    arrangeHandBtn.addEventListener('click', () => { const myPlayer = window.gameState?.players.find(p => p.playerId === myPersistentPlayerId); if (!myPlayer) return; const colorOrder = { 'Black': 0, 'Blue': 1, 'Green': 2, 'Red': 3, 'Yellow': 4 }; const valueOrder = { 'Draw Two': 12, 'Skip': 11, 'Reverse': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, '0': 0, 'Wild': -1, 'Wild Draw Four': -1, 'Wild Pick Until': -1, 'Wild Swap': -1 }; const sortedHand = [...myPlayer.hand].sort((a, b) => { const colorComparison = colorOrder[a.color] - colorOrder[b.color]; if (colorComparison !== 0) { return colorComparison; } return valueOrder[b.value] - valueOrder[a.value]; }); 
    // --- *** BUG FIX *** ---
    myPlayer.hand = sortedHand; // Was 'sortedhand' (lowercase)
    // --- *** END BUG FIX *** ---
    socket.emit('rearrangeHand', { newHand: sortedHand }); displayGame(window.gameState); });
    showDiscardPileBtn.addEventListener('click', () => { if (!window.gameState) return; const lastTenDiscards = window.gameState.discardPile.slice(0, 10); discardPileList.innerHTML = ''; if (lastTenDiscards.length === 0) { discardPileList.innerHTML = '<p>The discard pile is empty.</p>'; } else { lastTenDiscards.forEach(item => { const discardItemDiv = document.createElement('div'); discardItemDiv.className = 'discard-item'; const playerP = document.createElement('p'); playerP.className = 'discard-item-player'; playerP.textContent = `Played by: ${item.playerName}`; if (item.card) { const cardEl = createCardElement(item.card, -1); discardItemDiv.appendChild(cardEl); discardItemDiv.appendChild(playerP); discardPileList.appendChild(discardItemDiv); } else { console.warn("Discard pile item missing card data:", item); } }); } discardPileModal.style.display = 'flex'; });
    discardPileOkBtn.addEventListener('click', () => { discardPileModal.style.display = 'none'; });
    discardWildsOkBtn.addEventListener('click', () => { discardWildsModal.style.display = 'none'; });
    showLogBtn.addEventListener('click', () => {
        if (window.gameState && window.gameState.gameLog) {
            renderGameLog(window.gameState.gameLog); // Populate the modal
            gameLogModal.style.display = 'flex'; // Show the modal
        }
    });
    gameLogOkBtn.addEventListener('click', () => {
        gameLogModal.style.display = 'none'; // Hide the modal
    });


    // --- EVENT LISTENERS (Receiving messages from server) ---

    socket.on('connect', () => { console.log('Socket connected with ID:', socket.id); if (myPersistentPlayerId) { console.log('Attempting to rejoin with existing ID:', myPersistentPlayerId); const savedName = sessionStorage.getItem('unoPlayerName') || playerNameInput.value.trim() || "Player"; playerNameInput.value = savedName; socket.emit('joinGame', { playerName: savedName, playerId: myPersistentPlayerId }); } else { const savedName = sessionStorage.getItem('unoPlayerName'); if (savedName) playerNameInput.value = savedName; } });

    socket.on('joinSuccess', ({ playerId, lobby }) => {
        console.log('Successfully joined/rejoined with ID:', playerId);
        joinScreen.style.display = 'none'; // Ensure join screen is hidden on success
        myPersistentPlayerId = playerId;
        sessionStorage.setItem('unoPlayerId', playerId);
        const me = lobby.find(p => p.playerId === playerId);
        if (me) {
            sessionStorage.setItem('unoPlayerName', me.name);
            playerNameInput.value = me.name;
        }
        const isRejoiningGame = window.gameState && window.gameState.players && lobby.some(lobbyPlayer => window.gameState.players.some(gamePlayer => gamePlayer.playerId === lobbyPlayer.playerId));
        if (isRejoiningGame) {
            console.log("JoinSuccess received while game in progress (rejoin). Hiding lobby.");
            lobbyScreen.style.display = 'none';
        } else {
             console.log("JoinSuccess received for lobby. Rendering lobby.");
            renderLobby(lobby);
            lobbyScreen.style.display = 'block'; // Make sure lobby is visible
            gameBoard.style.display = 'none'; // Hide game board if it was somehow visible
        }
    });

    socket.on('lobbyUpdate', (currentLobbyPlayers) => {
        console.log('Received lobbyUpdate from server.');
        finalScoreModal.style.display = 'none';
        finalScoreOkBtn.disabled = false;
        if (lobbyWaitMessage) {
            lobbyWaitMessage.style.display = 'none';
        }
        isGameOver = false; // Ensure lobby can render
        if (!window.gameState || window.gameState.phase === 'Lobby' || window.gameState.phase === 'GameOver' || currentLobbyPlayers) {
            renderLobby(currentLobbyPlayers);
            joinScreen.style.display = 'none';
            gameBoard.style.display = 'none';
            lobbyScreen.style.display = 'block';
            endOfRoundDiv.style.display = 'none';
            window.gameState = null; // Clear game state when definitely back in lobby
        }
    });

    socket.on('forceDisconnect', () => { console.log("Received force disconnect from server."); showToast("You have been disconnected by the host."); sessionStorage.removeItem('unoPlayerId'); sessionStorage.removeItem('unoPlayerName'); myPersistentPlayerId = null; setTimeout(() => { location.reload(); }, 1500); });
    
    socket.on('updateGameState', (gameState) => { 
        handleMoveAnnouncement(gameState, previousGameState);
        previousGameState = JSON.parse(JSON.stringify(gameState)); // Deep copy
        
        window.gameState = gameState; 
        if (gameState.phase === 'Lobby') { 
            console.warn("Received gameState update with phase 'Lobby', rendering lobby."); 
            renderLobby(gameState.players); 
            joinScreen.style.display = 'none'; 
            gameBoard.style.display = 'none'; 
            lobbyScreen.style.display = 'block'; 
        } else if (gameState.phase === 'GameOver') { 
            /* finalGameOver handles this */ 
        } else { 
            joinScreen.style.display = 'none'; 
            lobbyScreen.style.display = 'none'; 
            gameBoard.style.display = 'flex'; 
            displayGame(gameState); 
        } 
    });
    
    socket.on('announceRoundWinner', ({ winnerNames }) => { 
        let message = `${winnerNames} wins the round!`; 
        if (winnerNames.includes(' and ')) { 
            message = `${winnerNames} win the round!`; 
        } 
        showWinnerAnnouncement(message, null, 3000); // NEW animation
    });
    
    socket.on('roundOver', ({ winnerName, scores, finalGameState }) => { 
        window.gameState = finalGameState; 
        setTimeout(() => { 
            displayGame(finalGameState); // Re-render board (now w/o hands)
            document.getElementById('winner-message').textContent = `${winnerName} win(s) the round!`; 
            const scoresDisplay = document.getElementById('scores-display'); 
            scoresDisplay.innerHTML = '<h3>Round Scores</h3>'; 
            const scoreTable = document.createElement('table'); 
            
            // --- *** MODIFICATION: Apply new uniform class *** ---
            scoreTable.className = 'uniform-score-table'; 
            // --- *** END MODIFICATION *** ---
            
            let tableHTML = '<thead><tr><th>Player</th><th class="score-col">Hand Score</th><th class="score-col">Total Score</th></tr></thead><tbody>'; 
            finalGameState.players.sort((a,b) => a.score - b.score).forEach(p => { 
                const roundScoreForPlayer = p.scoresByRound[p.scoresByRound.length - 1]; 
                const isWinner = winnerName.includes(p.name); 
                tableHTML += `<tr class="${isWinner ? 'winner-row' : ''}"><td>${p.name}</td><td class="score-col">${roundScoreForPlayer}</td><td class="score-col">${p.score}</td></tr>`; 
            }); 
            tableHTML += '</tbody>'; 
            scoreTable.innerHTML = tableHTML; 
            scoresDisplay.appendChild(scoreTable); 
            
            renderFinalHands(finalGameState.players); // Render final hands into the modal

        }, 1500); // Wait for animation
    }); 
    
    socket.on('announceFinalWinner', ({ winnerNames }) => { 
        const message = `${winnerNames} WIN(S) THE GAME!`; 
        showWinnerAnnouncement(message, "Loading final scores...", 5000); // NEW animation
    });
    
    socket.on('finalGameOver', (finalGameState) => { 
        isGameOver = true; 
        window.gameState = finalGameState; 
        gameBoard.style.display = 'none'; 
        endOfRoundDiv.style.display = 'none';
        
        hideWinnerAnnouncement(); // NEW
        
        renderFinalScores(finalGameState); 
        finalScoreModal.style.display = 'flex'; 
    });
    
    socket.on('drawnWildCard', ({ cardIndex, drawnCard }) => { const drawnWildCardName = document.getElementById('drawn-wild-card-name'); if (drawnWildCardName) { const cardName = drawnCard.value.replace(/([A-Z])/g, ' $1').trim().toUpperCase(); drawnWildCardName.textContent = `YOU DREW A ${cardName}!`; } drawnWildModal.dataset.cardIndex = cardIndex; drawnWildModal.style.display = 'flex'; });
    socket.on('announce', (message) => { showToast(message); }); // Uses the BIG toast
    socket.on('youWereMarkedAFK', () => { afkNotificationModal.style.display = 'flex'; });
    socket.on('unoCalled', ({ playerName }) => { showUnoAnnouncement(`${playerName} says UNO!`); });
    socket.on('showDiscardWildsModal', (allDiscardedData) => { discardWildsResults.innerHTML = ''; if (allDiscardedData.length === 0) { discardWildsResults.innerHTML = '<h3 class="discard-wilds-empty-msg">...but no other players had any Wild cards!</h3>'; } else { allDiscardedData.forEach(playerData => { const playerGroup = document.createElement('div'); playerGroup.className = 'discard-result-player'; const playerName = document.createElement('p'); playerName.className = 'discard-result-player-name'; playerName.textContent = `${playerData.playerName} discarded:`; playerGroup.appendChild(playerName); const cardContainer = document.createElement('div'); cardContainer.className = 'discard-result-cards'; if (playerData.cards.length === 0) { const noCardsMsg = document.createElement('span'); noCardsMsg.textContent = '(No cards)'; cardContainer.appendChild(noCardsMsg); } else { playerData.cards.forEach(card => { const cardEl = createCardElement(card, -1); cardContainer.appendChild(cardEl); }); } playerGroup.appendChild(cardContainer); discardWildsResults.appendChild(playerGroup); }); } discardWildsModal.style.display = 'flex'; });
    socket.on('animateDraw', ({ playerId, count }) => { animateCardDraw(playerId, count); });
    socket.on('animateSwap', ({ p1_id, p2_id }) => { animateHandSwap(p1_id, p2_id); });
    socket.on('animatePlay', ({ playerId, card, cardIndex }) => { animateCardPlay(playerId, card, cardIndex); });


    // --- ALL DISPLAY AND HELPER FUNCTIONS ---
    
    // *** MODIFIED: renderLobby function ***
    function renderLobby(currentLobbyPlayers) {
        const me = currentLobbyPlayers.find(p => p.playerId === myPersistentPlayerId);
        if (!me && sessionStorage.getItem('unoPlayerId')) {
            showToast("You may have been kicked or the session ended.");
            sessionStorage.removeItem('unoPlayerId');
            sessionStorage.removeItem('unoPlayerName');
            myPersistentPlayerId = null;
            setTimeout(() => { location.reload(); }, 1500);
            return;
        }
        if (!me) {
            console.error("Could not find player data in lobby.");
            joinScreen.style.display = 'block';
            lobbyScreen.style.display = 'none';
            gameBoard.style.display = 'none';
            return;
        }

        joinScreen.style.display = 'none';
        lobbyScreen.style.display = 'block';
        gameBoard.style.display = 'none';
        endOfRoundDiv.style.display = 'none';
        finalScoreModal.style.display = 'none';

        // Render player list
        playerList.innerHTML = '';
        const hostExistsForList = currentLobbyPlayers.some(p => p.isHost); // Check once
        
        currentLobbyPlayers.forEach(player => {
            if (!player.active) return;
            const playerItem = document.createElement('li');
            const playerInfoDiv = document.createElement('div');
            const statusDiv = document.createElement('div');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'player-name';
            let content = player.name;
            if (player.isHost) content += ' 👑 (Host)';
            if (player.playerId === myPersistentPlayerId) content += ' (You)';
            nameSpan.textContent = content;
            playerInfoDiv.appendChild(nameSpan);

            const readyStatusSpan = document.createElement('span');
            readyStatusSpan.className = 'ready-status';
            
            // Show ready status only if a host exists
            if (hostExistsForList) {
                 readyStatusSpan.innerHTML = player.isReady ? '✅ Ready' : '❌ Not Ready';
            } else {
                 readyStatusSpan.innerHTML = '🔹 Waiting...';
            }
            statusDiv.appendChild(readyStatusSpan);

            // Kick button logic (only host can kick, but host can't kick self)
            if (me.isHost && player.playerId !== myPersistentPlayerId) {
                const kickBtn = document.createElement('button');
                kickBtn.className = 'kick-btn';
                kickBtn.textContent = 'Kick';
                kickBtn.dataset.playerId = player.playerId;
                statusDiv.appendChild(kickBtn);
            }
            playerItem.appendChild(playerInfoDiv);
            playerItem.appendChild(statusDiv);
            playerList.appendChild(playerItem);
        });

        // --- *** NEW 3-STATE LOBBY UI LOGIC *** ---
        const host = currentLobbyPlayers.find(p => p.isHost);

        if (!host) {
            // State 1: No Host Exists
            playerLobbyActions.style.display = 'none';
            hostLobbyActions.style.display = 'none';
            claimHostSection.style.display = 'flex'; // Use flex as per new CSS
            hostMessage.textContent = 'Waiting for a player to become Host...';
            hostMessage.style.display = 'block';

        } else if (host && me.isHost) {
            // State 2: Host Exists, and I am the Host
            playerLobbyActions.style.display = 'none';
            hostLobbyActions.style.display = 'flex';
            claimHostSection.style.display = 'none';
            hostMessage.style.display = 'none'; // Host doesn't need the wait message

            // Host-specific logic (from original function)
            const activePlayers = currentLobbyPlayers.filter(p => p.active);
            const allReady = activePlayers.every(p => p.isReady);
            startGameBtn.disabled = !(activePlayers.length >= 2 && allReady);

        } else if (host && !me.isHost) {
            // State 3: Host Exists, and I am NOT the Host
            playerLobbyActions.style.display = 'flex';
            hostLobbyActions.style.display = 'none';
            claimHostSection.style.display = 'none';
            hostMessage.textContent = 'Waiting for the host to start the game'; // Original message
            hostMessage.style.display = 'block';

            // Player-specific logic (from original function)
            readyBtn.disabled = me.isReady;
            readyBtn.textContent = me.isReady ? 'Ready' : 'Set Ready';
        }
        // --- *** END NEW 3-STATE LOBBY UI LOGIC *** ---
    }
    // *** END MODIFIED function ***

    function showToast(message) { /* ... (unchanged) ... */ if (!toastNotification) return; toastNotification.textContent = message; toastNotification.classList.add('show'); setTimeout(() => { toastNotification.classList.remove('show'); }, 3000); }
    
    function showUnoAnnouncement(message) { /* ... (unchanged) ... */ unoAnnouncementText.textContent = message; if (message.length > 10) { unoAnnouncementText.style.fontSize = '8vw'; } else { unoAnnouncementText.style.fontSize = '15vw'; } unoAnnouncementOverlay.classList.add('show'); setTimeout(() => { unoAnnouncementOverlay.classList.remove('show'); }, 1900); }
    function isClientMoveValid(playedCard, gameState) { /* ... (unchanged) ... */ if (!gameState || !gameState.discardPile || gameState.discardPile.length === 0) return false; const topDiscard = gameState.discardPile[0]; if (!topDiscard || !topDiscard.card) return false; const topCard = topDiscard.card; const activeColor = gameState.activeColor; const drawPenalty = gameState.drawPenalty; if (drawPenalty > 0) { return playedCard.value === topCard.value; } if (playedCard.color === 'Black') return true; if (playedCard.color === activeColor || playedCard.value === topCard.value) return true; return false; }
    function playerHasPlayableNonWildCard(gameState) { /* ... (unchanged) ... */ if (!gameState || !gameState.players || !gameState.discardPile || gameState.discardPile.length === 0) { return false; } const myPlayer = gameState.players.find(p => p.playerId === myPersistentPlayerId); if (!myPlayer) { return false; } const isMyTurn = gameState.players[gameState.currentPlayerIndex]?.playerId === myPersistentPlayerId; const isPlaying = gameState.phase === 'Playing'; const noPenalty = gameState.drawPenalty === 0 && !gameState.pickUntilState?.active; if (!isMyTurn || !isPlaying || !noPenalty) { return false; } for (const card of myPlayer.hand) { if (card.color !== 'Black') { if (isClientMoveValid(card, gameState)) { return true; } } } return false; }
    function triggerInvalidMoveFeedback(cardElement) { /* ... (unchanged) ... */ cardElement.classList.add('invalid-shake'); const cardRect = cardElement.getBoundingClientRect(); const boardRect = gameBoard.getBoundingClientRect(); invalidMoveCallout.style.top = `${cardRect.top - boardRect.top - 40}px`; invalidMoveCallout.style.left = `${cardRect.left - boardRect.left + (cardRect.width / 2) - (invalidMoveCallout.offsetWidth / 2)}px`; invalidMoveCallout.classList.add('show'); setTimeout(() => { cardElement.classList.remove('invalid-shake'); }, 500); setTimeout(() => { invalidMoveCallout.classList.remove('show'); }, 1500); }
    function animateCardPlay(playerId, card, cardIndex) { /* ... (unchanged) ... */ const discardPileEl = document.querySelector('#discard-pile-dropzone .card'); const playerAreaEl = document.querySelector(`[data-player-id="${playerId}"]`); if (!discardPileEl || !playerAreaEl) return; const startRect = playerAreaEl.getBoundingClientRect(); const endRect = discardPileEl.getBoundingClientRect(); const boardRect = gameBoard.getBoundingClientRect(); const clone = createCardElement(card, -1); clone.classList.add('flying-card'); clone.style.top = `${startRect.top - boardRect.top + (startRect.height / 2) - 60}px`; clone.style.left = `${startRect.left - boardRect.left + (startRect.width / 2) - 40}px`; clone.style.width = '80px'; clone.style.height = '120px'; if (playerId === myPersistentPlayerId && window.gameState) { const myPlayer = window.gameState.players.find(p => p.playerId === myPersistentPlayerId); if (myPlayer) { const cardToHide = playerAreaEl.querySelector(`.card[data-card-index="${cardIndex}"]`); if(cardToHide) cardToHide.style.visibility = 'hidden'; else { const cards = playerAreaEl.querySelectorAll('.card-container .card'); if (cards.length > 0) cards[cards.length - 1].style.visibility = 'hidden'; } } } gameBoard.appendChild(clone); requestAnimationFrame(() => { clone.style.top = `${endRect.top - boardRect.top}px`; clone.style.left = `${endRect.left - boardRect.left}px`; clone.style.transform = `rotate(360deg)`; clone.style.width = `${endRect.width}px`; clone.style.height = `${endRect.height}px`; }); setTimeout(() => { clone.remove(); }, 800); }
    function animateCardDraw(playerId, count) { /* ... (unchanged) ... */ const drawPileEl = document.querySelector('.piles-container .card-back'); const playerAreaEl = document.querySelector(`[data-player-id="${playerId}"] .card-container`); if (!drawPileEl || !playerAreaEl) return; const startRect = drawPileEl.getBoundingClientRect(); const endRect = playerAreaEl.getBoundingClientRect(); const boardRect = gameBoard.getBoundingClientRect(); const smallCardWidth = 80; const scaleFactor = smallCardWidth / startRect.width; for (let i = 0; i < count; i++) { const cardBack = document.createElement('div'); cardBack.className = 'card card-back flying-card'; cardBack.style.top = `${startRect.top - boardRect.top}px`; cardBack.style.left = `${startRect.left - boardRect.top}px`; cardBack.style.width = `${startRect.width}px`; cardBack.style.height = `${startRect.height}px`; cardBack.style.transform = 'scale(1.2)'; gameBoard.appendChild(cardBack); setTimeout(() => { requestAnimationFrame(() => { const top = `${endRect.top - boardRect.top + 10}px`; const left = `${endRect.left - boardRect.left + (i * (smallCardWidth / 4))}px`; cardBack.style.transform = `scale(${scaleFactor})`; cardBack.style.top = top; cardBack.style.left = left; cardBack.style.width = `${smallCardWidth}px`; cardBack.style.height = `${smallCardWidth * 1.5}px`; }); }, i * 100 + 50); setTimeout(() => { cardBack.remove(); }, 800 + (i * 100)); } }
    function animateHandSwap(p1_id, p2_id) { /* ... (unchanged) ... */ const p1_area = document.querySelector(`[data-player-id="${p1_id}"]`); const p2_area = document.querySelector(`[data-player-id="${p2_id}"]`); if (!p1_area || !p2_area) return; const p1_cards = p1_area.querySelectorAll('.card-container .card'); const p2_cards = p2_area.querySelectorAll('.card-container .card'); const boardRect = gameBoard.getBoundingClientRect(); const animateHand = (cards, toArea) => { const endRect = toArea.querySelector('.card-container').getBoundingClientRect(); const clones = []; cards.forEach(card => { const startRect = card.getBoundingClientRect(); const clone = card.cloneNode(true); clone.classList.add('flying-card'); clone.style.top = `${startRect.top - boardRect.top}px`; clone.style.left = `${startRect.left - boardRect.left}px`; gameBoard.appendChild(clone); clones.push(clone); card.style.visibility = 'hidden'; }); clones.forEach((clone, i) => { setTimeout(() => { requestAnimationFrame(() => { const top = `${endRect.top - boardRect.top + 10}px`; const left = `${endRect.left - boardRect.left + (i * 20)}px`; clone.style.top = top; clone.style.left = left; }); }, i * 50); setTimeout(() => clone.remove(), 800 + (i*50)); }); }; animateHand(p1_cards, p2_area); animateHand(p2_cards, p1_area); }
    
    function renderGameLog(logHistory) { /* ... (unchanged, still populates modal) ... */ if (!gameLogModalContent) return; gameLogModalContent.innerHTML = ''; if (!logHistory) return; logHistory.forEach(msg => { const entryDiv = document.createElement('div'); entryDiv.textContent = msg; gameLogModalContent.appendChild(entryDiv); }); gameLogModalContent.scrollTop = 0; }
    
    function renderFinalScores(finalGameState) { 
        const players = finalGameState.players; 
        const numRounds = finalGameState.roundNumber; 
        const table = document.createElement('table'); 
        
        // --- *** MODIFICATION: Apply new uniform class *** ---
        table.className = 'uniform-score-table'; 
        // --- *** END MODIFICATION *** ---

        let headerHtml = '<thead><tr><th>Round</th>'; 
        players.forEach(p => { headerHtml += `<th>${p.name}</th>`; }); 
        headerHtml += '</tr></thead>'; 
        let bodyHtml = '<tbody>'; 
        for (let i = 0; i < numRounds; i++) { 
            bodyHtml += `<tr><td>${i + 1}</td>`; 
            players.forEach(p => { 
                const score = p.scoresByRound[i] !== undefined ? p.scoresByRound[i] : '-'; 
                bodyHtml += `<td class="score-col">${score}</td>`; 
            }); 
            bodyHtml += '</tr>'; 
        } 
        bodyHtml += '</tbody>'; 
        let footerHtml = '<tfoot><tr><td><strong>Total</strong></td>'; 
        let lowestScore = Infinity; 
        players.forEach(p => { 
            if (p.status === 'Active' || p.status === 'Disconnected') { 
                if (p.score < lowestScore) { lowestScore = p.score; } 
            } 
            footerHtml += `<td class="score-col"><strong>${p.score}</strong></td>`; 
        }); 
        footerHtml += '</tr></tfoot>'; 
        table.innerHTML = headerHtml + bodyHtml + footerHtml; 
        finalScoreTableContainer.innerHTML = ''; 
        finalScoreTableContainer.appendChild(table); 
        const winners = players.filter(p => (p.status === 'Active' || p.status === 'Disconnected') && p.score === lowestScore); 
        const winnerNames = winners.map(w => w.name).join(' and '); 
        finalWinnerMessage.textContent = `${winnerNames} win(s) the game!`; 
    }
    
    function createSmallCardImage(card) { /* ... (unchanged) ... */ const cardDiv = document.createElement('div'); if (!card || !card.color || !card.value) { console.error("Attempted to create small card with invalid data:", card); cardDiv.className = 'final-card-img Black'; cardDiv.textContent = '?'; return cardDiv; } cardDiv.className = `final-card-img ${card.color}`; if (!isNaN(card.value)) { const numberSpan = document.createElement('span'); numberSpan.className = 'number-circle'; numberSpan.textContent = card.value; cardDiv.appendChild(numberSpan); } else { const actionSpan = document.createElement('span'); actionSpan.className = 'action-text'; actionSpan.innerHTML = card.value.replace(/\s/g, '<br>'); cardDiv.appendChild(actionSpan); } return cardDiv; }
    function renderFinalHands(players) { /* ... (unchanged) ... */ const container = document.getElementById('round-over-hands'); if (!container) return; container.innerHTML = ''; if (!players) return; const sortedPlayers = [...players].sort((a,b) => a.score - b.score); sortedPlayers.forEach(player => { if (player.status === 'Removed') return; const hand = player.hand; const handDiv = document.createElement('div'); handDiv.className = 'player-hand-display'; const nameEl = document.createElement('div'); nameEl.className = 'player-hand-name'; nameEl.textContent = `${player.name}:`; handDiv.appendChild(nameEl); const cardsContainer = document.createElement('div'); cardsContainer.className = 'player-hand-cards'; if (hand && hand.length > 0) { hand.sort((a, b) => { const colorOrder = { 'Black': 0, 'Blue': 1, 'Green': 2, 'Red': 3, 'Yellow': 4 }; const valueOrder = { 'Draw Two': 12, 'Skip': 11, 'Reverse': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, '0': 0, 'Wild': -1, 'Wild Draw Four': -1, 'Wild Pick Until': -1, 'Wild Swap': -1 }; const colorComparison = colorOrder[a.color] - colorOrder[b.color]; if (colorComparison !== 0) return colorComparison; return valueOrder[b.value] - valueOrder[a.value]; }); hand.forEach(card => { cardsContainer.appendChild(createSmallCardImage(card)); }); } else { cardsContainer.textContent = '(Empty)'; } handDiv.appendChild(cardsContainer); container.appendChild(handDiv); }); }
    function createCardElement(card, cardIndex) { /* ... (unchanged) ... */ const cardDiv = document.createElement('div'); if (!card || !card.color || !card.value) { console.error("Attempted to create card element with invalid data:", card); cardDiv.className = 'card Black'; cardDiv.textContent = '?'; return cardDiv; } cardDiv.className = `card ${card.color}`; cardDiv.dataset.cardIndex = cardIndex; if (!isNaN(card.value)) { const numberSpan = document.createElement('span'); numberSpan.className = 'number-circle'; numberSpan.textContent = card.value; cardDiv.appendChild(numberSpan); } else { const actionSpan = document.createElement('span'); actionSpan.className = 'action-text'; actionSpan.innerHTML = card.value.replace(/\s/g, '<br>'); cardDiv.appendChild(actionSpan); } return cardDiv; }
    function makeDraggable(element) { /* ... (unchanged) ... */ let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0; const header = element.querySelector('.modal-content h3, .modal-content h2, .modal-content p'); function dragMouseDown(e) { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; } function touchDown(e) { pos3 = e.touches[0].clientX; pos4 = e.touches[0].clientY; document.ontouchend = closeDragElement; document.ontouchmove = elementTouchDrag; } function elementDrag(e) { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; let newTop = element.offsetTop - pos2; let newLeft = element.offsetLeft - pos1; element.style.top = newTop + "px"; element.style.left = newLeft + "px"; } function elementTouchDrag(e) { e.preventDefault(); pos1 = pos3 - e.touches[0].clientX; pos2 = pos4 - e.touches[0].clientY; pos3 = e.touches[0].clientX; pos4 = e.touches[0].clientY; let newTop = element.offsetTop - pos2; let newLeft = element.offsetLeft - pos1; element.style.top = newTop + "px"; element.style.left = newLeft + "px"; } function closeDragElement() { document.onmouseup = null; document.onmousemove = null; document.ontouchend = null; document.ontouchmove = null; } if (header) { header.style.cursor = 'move'; header.onmousedown = dragMouseDown; header.ontouchstart = touchDown; } else { const content = element.querySelector('.modal-content'); if (content) { content.style.cursor = 'move'; content.onmousedown = dragMouseDown; content.onmousedown = dragMouseDown; content.ontouchstart = touchDown; } } }
    
    function displayGame(gameState) { 
        window.gameState = gameState; 
        
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; } 
        colorPickerModal.style.display = 'none'; 
        pickUntilModal.style.display = 'none'; 
        dealChoiceModal.style.display = 'none'; 
        endOfRoundDiv.style.display = 'none'; 
        finalScoreModal.style.display = 'none'; 
        swapModal.style.display = 'none'; 
        drawnWildModal.style.display = 'none'; 
        renderPlayers(gameState); 
        renderPiles(gameState); 
        updateDirectionArrow(gameState); 
        // REMOVED: renderGameLog call
        const myPlayer = gameState.players.find(p => p.playerId === myPersistentPlayerId); 
        if (!myPlayer) { showToast("Error: Could not find your player data."); return; } 
        const currentPlayer = gameState.players[gameState.currentPlayerIndex]; 
        const playerChoosingAction = gameState.players.find(p => p.playerId === gameState.playerChoosingActionId); 
        const isMyTurn = myPlayer && currentPlayer?.playerId === myPlayer.playerId; 
        const amIChoosingAction = myPlayer && playerChoosingAction?.playerId === myPlayer.playerId; 
        const isPaused = gameState.isPaused; 
        const isHost = myPlayer.isHost; 
        if (actionBar) { actionBar.textContent = getActionBarText(gameState, currentPlayer, playerChoosingAction); } 
        switch (gameState.phase) { 
            case 'ChoosingColor': if (amIChoosingAction && !isPaused) colorPickerModal.style.display = 'flex'; break; 
            case 'ChoosingPickUntilAction': if (amIChoosingAction && !isPaused) pickUntilModal.style.display = 'flex'; break; 
            case 'ChoosingSwapHands': if (amIChoosingAction && !isPaused) { const swapOptions = document.getElementById('swap-player-options'); swapOptions.innerHTML = ''; gameState.players.forEach(player => { if (player.playerId !== myPersistentPlayerId && player.status === 'Active') { const button = document.createElement('button'); button.textContent = player.name; button.className = 'player-swap-btn'; button.dataset.playerId = player.playerId; swapOptions.appendChild(button); } }); swapModal.style.display = 'flex'; } break; 
            case 'Dealing': if (amIChoosingAction && !isPaused) dealChoiceModal.style.display = 'flex'; break; 
            case 'RoundOver': 
                endOfRoundDiv.style.display = 'flex'; 
                const me = gameState.players.find(p => p.playerId === myPersistentPlayerId); 
                const isReady = gameState.readyForNextRound.includes(myPersistentPlayerId); 
                if (me && !me.isHost) { 
                    nextRoundOkBtn.style.display = 'block'; 
                    hostRoundEndControls.style.display = 'none'; 
                    if (isReady) { nextRoundOkBtn.disabled = true; nextRoundOkBtn.textContent = 'Waiting for Host...'; } 
                    else { nextRoundOkBtn.disabled = false; nextRoundOkBtn.textContent = 'OK'; } 
                } else if (me && me.isHost) { 
                    nextRoundOkBtn.style.display = 'none'; 
                    hostRoundEndControls.style.display = 'flex'; 
                    if (isReady) { nextRoundBtn.disabled = true; nextRoundBtn.textContent = 'Waiting...'; } 
                    else { nextRoundBtn.disabled = false; nextRoundBtn.textContent = 'Start Next Round'; } 
                } 
                break; 
            case 'GameOver': 
                finalScoreModal.style.display = 'flex'; 
                break; 
        } 
        endGameBtn.style.display = (isHost && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') ? 'block' : 'none'; 
        if (unoBtn) { const colorMap = { "Red": "#ff5555", "Green": "#55aa55", "Blue": "#5555ff", "Yellow": "#ffaa00" }; unoBtn.style.backgroundColor = colorMap[gameState.activeColor] || '#333'; const canDeclareUno = isMyTurn && gameState.phase === 'Playing' && myPlayer.hand.length === 2 && !isPaused; unoBtn.disabled = !canDeclareUno; unoBtn.classList.toggle('uno-ready', canDeclareUno); } 
        if (drawCardBtn) { 
            let drawBtnText = 'DRAW CARD'; 
            let drawBtnDisabled = true; 
            if (!isPaused && gameState.phase === 'Playing') { 
                if (isMyTurn) { 
                    const pickUntilInfo = gameState.pickUntilState; 
                    const isPickingUntil = pickUntilInfo?.active && pickUntilInfo.targetPlayerIndex === gameState.currentPlayerIndex; 
                    if (isPickingUntil) { 
                        drawBtnText = `${currentPlayer.name} PICKS FOR ${pickUntilInfo.targetColor.toUpperCase()}`; 
                        drawBtnDisabled = false; 
                    } else if (gameState.drawPenalty > 0) { 
                        drawBtnText = `${currentPlayer.name} DRAWS ${gameState.drawPenalty}`; 
                        drawBtnDisabled = false; 
                    } else { 
                        drawBtnText = 'DRAW CARD'; 
                        drawBtnDisabled = false; 
                        if (playerHasPlayableNonWildCard(gameState)) { drawBtnDisabled = true; } 
                    } 
                } else { 
                    drawBtnDisabled = true; 
                    const pickUntilInfo = gameState.pickUntilState; 
                    const isPickingUntil = pickUntilInfo?.active && pickUntilInfo.targetPlayerIndex === gameState.currentPlayerIndex; 
                    if(isPickingUntil) { 
                        drawBtnText = `${currentPlayer?.name} PICKS FOR ${pickUntilInfo.targetColor.toUpperCase()}`; 
                    } else if (gameState.drawPenalty > 0 && gameState.currentPlayerIndex === gameState.players.findIndex(p => p.playerId === currentPlayer?.playerId)) { 
                        drawBtnText = `${currentPlayer?.name} DRAWS ${gameState.drawPenalty}`; 
                    } else { 
                        drawBtnText = 'DRAW CARD'; 
                    } 
                } 
            } else { 
                drawBtnDisabled = true; 
                drawBtnText = 'DRAW CARD'; 
            } 
            drawCardBtn.textContent = drawBtnText; 
            drawCardBtn.disabled = drawBtnDisabled; 
        } 
    }
    
    function getActionBarText(gameState, currentPlayer, playerChoosingAction) { /* ... (unchanged) ... */ if (gameState.isPaused && gameState.pauseInfo?.pauseEndTime) { const { pauseEndTime, pausedForPlayerNames } = gameState.pauseInfo; const names = pausedForPlayerNames.join(', '); const updateTimer = () => { const remaining = Math.max(0, Math.floor((pauseEndTime - Date.now()) / 1000)); actionBar.textContent = `Waiting ${remaining}s for ${names} to rejoin...`; if (!countdownInterval && remaining > 0) { countdownInterval = setInterval(updateTimer, 1000); } else if (remaining <= 0 && countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; } }; updateTimer(); return actionBar.textContent; } if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; } switch(gameState.phase) { case 'Lobby': return "Waiting for players..."; case 'Dealing': return playerChoosingAction ? `Waiting for ${playerChoosingAction.name} (Dealer) to deal...` : 'Waiting for dealer...'; case 'Playing': if (gameState.pickUntilState?.active && gameState.pickUntilState.targetPlayerIndex === gameState.currentPlayerIndex) { return `${currentPlayer.name} must pick until they find a ${gameState.pickUntilState.targetColor}!`; } else if (gameState.drawPenalty > 0 && gameState.currentPlayerIndex === gameState.players.findIndex(p => p.playerId === currentPlayer?.playerId)) { return `${currentPlayer.name} must draw ${gameState.drawPenalty}!`; } return currentPlayer ? `Waiting for ${currentPlayer.name} to play...` : 'Waiting for player...'; case 'ChoosingColor': return playerChoosingAction ? `${playerChoosingAction.name} is choosing a color...` : 'Choosing a color...'; case 'ChoosingPickUntilAction': return playerChoosingAction ? `${playerChoosingAction.name} is choosing Wild Pick Until action...` : 'Choosing action...'; case 'ChoosingSwapHands': return playerChoosingAction ? `${playerChoosingAction.name} is choosing who to swap with...` : 'Choosing swap target...'; case 'RoundOver': const host = gameState.players.find(p => p.isHost); const hostIsReady = gameState.readyForNextRound.includes(host?.playerId); const connectedPlayers = gameState.players.filter(p => p.status === 'Active'); const allReady = gameState.readyForNextRound.length === connectedPlayers.length; if (hostIsReady && !allReady) { const waitingOnPlayers = connectedPlayers.filter(p => !gameState.readyForNextRound.includes(p.playerId)); const waitingOnNames = waitingOnPlayers.map(p => p.name).join(', '); return `Waiting for ${waitingOnNames} to click OK...`; } else if (!hostIsReady && allReady) { return `Waiting for ${host?.name} (Host) to start next round...`; } else { return `Round Over! Waiting for players...`; } case 'GameOver': return "Game Over!"; default: "Loading..."; } }
    function updateDirectionArrow(gameState) { /* ... (unchanged) ... */ const currentDirectionArrow = document.getElementById('direction-arrow'); if (!currentDirectionArrow) { console.error("Direction arrow element not found"); return; } currentDirectionArrow.classList.toggle('reversed', gameState.playDirection === -1); const arrowSvgPath = currentDirectionArrow.querySelector('svg path'); if (arrowSvgPath) { const activeColor = gameState.activeColor || 'Black'; const colorMap = { "Red": "#ff5555", "Green": "#55aa55", "Blue": "#5555ff", "Yellow": "#ffaa00", "Black": "#FFFFFF" }; arrowSvgPath.style.fill = colorMap[activeColor] || '#FFFFFF'; } }
    function renderPiles(gameState) { /* ... (unchanged) ... */ const pilesArea = document.getElementById('piles-area'); pilesArea.innerHTML = ''; const pilesContainer = document.createElement('div'); pilesContainer.className = 'piles-container'; const drawPileWrapper = document.createElement('div'); drawPileWrapper.className = 'pile-wrapper'; const drawPileTitle = document.createElement('h4'); drawPileTitle.textContent = 'Draw Pile'; const drawCount = document.createElement('div'); drawCount.className = 'pile-count'; drawCount.textContent = `(${gameState.drawPile.length} Cards)`; const cardBackElement = document.createElement('div'); cardBackElement.className = 'card card-back'; cardBackElement.innerHTML = 'U<br>N<br>O'; drawPileWrapper.appendChild(drawPileTitle); drawPileWrapper.appendChild(drawCount); drawPileWrapper.appendChild(cardBackElement); pilesContainer.appendChild(drawPileWrapper); const arrowElement = document.createElement('div'); arrowElement.id = 'direction-arrow'; arrowElement.innerHTML = ` <svg viewBox="0 0 100 220" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; filter: drop-shadow(1px 1px 2px black);"> <path d="M50 210 L95 170 L80 170 L80 10 L20 10 L20 170 L5 170 Z" /> </svg> `; pilesContainer.appendChild(arrowElement); const discardPileWrapper = document.createElement('div'); discardPileWrapper.className = 'pile-wrapper'; const discardPileTitle = document.createElement('h4'); discardPileTitle.textContent = 'Discard Pile'; const discardCount = document.createElement('div'); discardCount.className = 'pile-count'; discardCount.textContent = `(${gameState.discardPile.length} Cards)`; const discardPileDiv = document.createElement('div'); discardPileDiv.id = 'discard-pile-dropzone'; const topDiscard = gameState.discardPile[0]; if (topDiscard && topDiscard.card) { const topCardElement = createCardElement(topDiscard.card, -1); discardPileDiv.appendChild(topCardElement); } discardPileWrapper.appendChild(discardPileTitle); discardPileWrapper.appendChild(discardCount); discardPileWrapper.appendChild(discardPileDiv); pilesContainer.appendChild(discardPileWrapper); pilesArea.appendChild(pilesContainer); const dropZone = document.getElementById('discard-pile-dropzone'); if (dropZone) { dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('over'); }; dropZone.ondragleave = () => { dropZone.classList.remove('over'); }; dropZone.ondrop = (e) => { e.preventDefault(); dropZone.classList.remove('over'); if (draggedCardIndex !== -1) { const myPlayer = window.gameState?.players.find(p => p.playerId === myPersistentPlayerId); const currentPlayer = window.gameState?.players[window.gameState.currentPlayerIndex]; const isMyTurn = myPlayer && currentPlayer && currentPlayer.playerId === myPlayer.playerId; if(window.gameState && isMyTurn && window.gameState.phase === 'Playing' && !window.gameState.isPaused) { const playedCard = myPlayer.hand[draggedCardIndex]; if (isClientMoveValid(playedCard, window.gameState)) { socket.emit('playCard', { cardIndex: draggedCardIndex }); } else { if (draggedCardElement) { triggerInvalidMoveFeedback(draggedCardElement); } } } if (draggedCardElement) draggedCardElement.style.opacity = '1'; draggedCardElement = null; draggedCardIndex = -1; } }; } }
    
    function renderPlayers(gameState) { /* ... (unchanged) ... */ const leftColumn = document.getElementById('left-column'); leftColumn.innerHTML = ''; const myPlayer = gameState.players.find(p => p.playerId === myPersistentPlayerId); if (!myPlayer) return; const isHost = myPlayer.isHost; const currentPlayer = gameState.players[gameState.currentPlayerIndex]; gameState.players.forEach((player, playerIndex) => { const playerArea = document.createElement('div'); playerArea.className = 'player-area'; playerArea.dataset.playerId = player.playerId; playerArea.classList.toggle('disconnected', player.status === 'Disconnected'); playerArea.classList.toggle('removed', player.status === 'Removed'); const isCurrentPlayer = currentPlayer?.playerId === player.playerId; const isDealerChoosing = gameState.phase === 'Dealing' && player.playerId === gameState.playerChoosingActionId; playerArea.classList.toggle('active-player', (isCurrentPlayer && player.status === 'Active' && !gameState.isPaused && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') || isDealerChoosing); playerArea.classList.toggle('uno-unsafe', player.unoState === 'unsafe'); playerArea.classList.toggle('uno-declared', player.unoState === 'declared' && player.playerId === myPersistentPlayerId); playerArea.classList.toggle('has-uno', player.hand.length === 1 && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver'); const playerInfo = document.createElement('div'); playerInfo.className = 'player-info'; const nameSpan = document.createElement('span'); const hostIndicator = player.isHost ? '👑 ' : ''; nameSpan.innerHTML = `${hostIndicator}${player.name} (${player.hand.length} cards) <span class="player-score">Score: ${player.score}</span>`; playerInfo.appendChild(nameSpan); if (isHost && player.playerId !== myPersistentPlayerId && player.status === 'Active' && gameState.phase !== 'RoundOver' && gameState.phase !== 'GameOver') { const afkBtn = document.createElement('button'); afkBtn.className = 'mark-afk-btn'; afkBtn.textContent = 'Mark AFK'; afkBtn.dataset.playerId = player.playerId; playerInfo.appendChild(afkBtn); } playerArea.appendChild(playerInfo); const cardContainer = document.createElement('div'); cardContainer.className = 'card-container'; if (player.playerId === myPersistentPlayerId) { const currentHand = player.hand; currentHand.forEach((card, indexInHand) => { const originalCardIndex = indexInHand; const cardEl = createCardElement(card, originalCardIndex); const isMyTurn = isCurrentPlayer; const canPlay = isMyTurn && gameState.phase === 'Playing' && !gameState.isPaused && player.status === 'Active'; cardEl.classList.toggle('clickable', canPlay); cardEl.addEventListener('click', () => { if (canPlay) { if (isClientMoveValid(card, gameState)) { socket.emit('playCard', { cardIndex: originalCardIndex }); } else { triggerInvalidMoveFeedback(cardEl); } } }); cardEl.draggable = true; cardContainer.appendChild(cardEl); }); cardContainer.ondragstart = e => { if (!e.target.classList.contains('card') || !e.target.draggable) { e.preventDefault(); return; } draggedCardElement = e.target; draggedCardIndex = parseInt(e.target.dataset.cardIndex); setTimeout(() => e.target.classList.add('dragging'), 0); }; cardContainer.ondragend = e => { if (draggedCardElement) { draggedCardElement.classList.remove('dragging'); draggedCardElement.style.opacity = '1'; const myCurrentPlayerState = window.gameState?.players.find(p => p.playerId === myPersistentPlayerId); if (myCurrentPlayerState) { const newElements = [...cardContainer.querySelectorAll('.card')]; const validElements = newElements.filter(el => el !== draggedCardElement || !el.classList.contains('dragging')); const newIndices = validElements.map(el => parseInt(el.dataset.cardIndex)); const serverHand = myCurrentPlayerState.hand; if (newIndices.length === serverHand.length && newIndices.every(idx => idx >= 0 && idx < serverHand.length)) { const reorderedHand = newIndices.map(originalIndex => serverHand[originalIndex]).filter(Boolean); if (reorderedHand.length === serverHand.length) { socket.emit('rearrangeHand', { newHand: reorderedHand }); myPlayer.hand = reorderedHand; } } else { console.warn("Index mismatch during drag reorder, not sending update."); } } draggedCardElement = null; draggedCardIndex = -1; } }; cardContainer.ondragover = e => { e.preventDefault(); if (!draggedCardElement || window.gameState?.isPaused) return; const afterElement = getDragAfterElement(cardContainer, e.clientX); if (afterElement == null) { cardContainer.appendChild(draggedCardElement); } else { cardContainer.insertBefore(draggedCardElement, afterElement); } }; } else { if (gameState.phase === 'RoundOver' && player.status === 'Active') { if (player.hand.length === 1 && gameState.phase !== 'GameOver') { const cardEl = document.createElement('div'); cardEl.className = 'card uno-warning'; const unoSpan = document.createElement('span'); unoSpan.textContent = 'UNO'; cardEl.appendChild(unoSpan); cardContainer.appendChild(cardEl); } else { for (let j = 0; j < player.hand.length; j++) { const cardEl = document.createElement('div'); cardEl.className = 'card card-back'; cardContainer.appendChild(cardEl); } } } else { if (player.hand.length === 1 && gameState.phase !== 'GameOver') { const cardEl = document.createElement('div'); cardEl.className = 'card uno-warning'; const unoSpan = document.createElement('span'); unoSpan.textContent = 'UNO'; cardEl.appendChild(unoSpan); cardContainer.appendChild(cardEl); } else { for (let j = 0; j < player.hand.length; j++) { const cardEl = document.createElement('div'); cardEl.className = 'card card-back'; cardContainer.appendChild(cardEl); } } } } playerArea.appendChild(cardContainer); leftColumn.appendChild(playerArea); }); }
    
    function getDragAfterElement(container, x) { /* ... (unchanged) ... */ const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')]; return draggableElements.reduce((closest, child) => { const box = child.getBoundingClientRect(); const offset = x - box.left - box.width / 2; if (offset < 0 && offset > closest.offset) { return { offset: offset, element: child }; } else { return closest; } }, { offset: Number.NEGATIVE_INFINITY }).element; }
    makeDraggable(document.getElementById('color-picker-modal')); makeDraggable(document.getElementById('drawn-wild-modal')); makeDraggable(document.getElementById('pick-until-modal')); makeDraggable(document.getElementById('swap-modal')); makeDraggable(document.getElementById('deal-choice-modal')); makeDraggable(document.getElementById('confirm-end-game-modal')); makeDraggable(document.getElementById('end-of-round-div')); makeDraggable(document.getElementById('final-score-modal')); makeDraggable(document.getElementById('afk-notification-modal')); makeDraggable(document.getElementById('discard-pile-modal')); makeDraggable(document.getElementById('confirm-afk-modal')); makeDraggable(document.getElementById('discard-wilds-modal'));
    makeDraggable(document.getElementById('confirm-hard-reset-modal'));
    makeDraggable(document.getElementById('game-log-modal')); 
    
    // *** MODIFIED: handleMoveAnnouncement (Final fix + Added Disconnected check) ***
    function handleMoveAnnouncement(currentState, prevState) { 
        if (!previousGameState || !currentState || !currentState.gameLog || currentState.gameLog.length === 0) {
            return;
        }

        // *** ADDED: Check for Removed or Disconnected status ***
        const me = currentState.players.find(p => p.playerId === myPersistentPlayerId);
        if (me && (me.status === 'Removed' || me.status === 'Disconnected')) {
            return; // Don't show toasts if removed OR disconnected
        }
        // *** END ADDED ***

        const latestLog = currentState.gameLog[0];
        const previousLog = previousGameState.gameLog[0];

        // 1. Skip if log hasn't changed or is a non-move
        if (latestLog === previousLog || latestLog.includes('Round ') || latestLog.includes('🏁') || latestLog.includes('Game initialized.')) {
             return;
        }
        
        // 2. UNO PENALTY (Highest Priority Announcement)
        if (latestLog.startsWith('🚨 Penalty on ') && latestLog.includes(' for not calling UNO.')) { // Check prefix
            const match = latestLog.match(/🚨 Penalty on (.*?) for not calling UNO/);
            const nextPlayer = currentState.players[currentState.currentPlayerIndex];
            const nextPlayerName = nextPlayer ? nextPlayer.name : "Unknown";
            if (match) {
                 const penalizedPlayerName = match[1];
                 const message = `🚨 Penalty on ${penalizedPlayerName} for not calling UNO! Next: ${nextPlayerName}`;
                 showToast(message); 
                 return; // Handled, exit early
            }
        }
        
        // 3. Keep the non-toast penalty check below (for Draw Penalty / Announce events)
        if (latestLog.includes('penalty on')) { // This catches server-side draw penalties from 'announce'
             return; 
        }

        let message = "";
        const nextPlayer = currentState.players[currentState.currentPlayerIndex];
        const nextPlayerName = nextPlayer ? nextPlayer.name : "Unknown";

        // 4. Other actions
        if (latestLog.includes('chose the color')) {
            const match = latestLog.match(/🎨 (.+?) chose the color (.+?)\./);
            if (match) {
                 message = `${match[1]} chose ${match[2]}. Next: ${nextPlayerName}`;
            }
        } else if (latestLog.includes('played a')) {
            const match = latestLog.match(/› (.+?) played a (.+?)\./);
            if(match) {
                 let cardName = match[2].replace('Black ', ''); 
                 message = `${match[1]} played ${cardName}. Next: ${nextPlayerName}`;
            }
        } else if (latestLog.includes('drew a card.')) {
            // *** SIMPLIFIED LOGIC (v4) ***
            // Suppress toast if the draw triggered the wild choice modal (based on previous state's pending action)
            const wasWildChoicePending = previousGameState?.pendingAction?.type === 'wild-draw-choice';

            if (!wasWildChoicePending) {
                 // The server now sends "drew a card." for both non-playable and kept Wilds.
                 const drewMatch = latestLog.match(/› (.*?)(?: drew a card|\. Next)/);
                 const playerName = drewMatch ? drewMatch[1] : "Someone";
                 message = `${playerName} drew a card. Next: ${nextPlayerName}`;
            }
            // If wasWildChoicePending is true, message remains empty, suppressing the reveal.

        } else if (latestLog.includes('...and it was a playable')) { // Auto-play non-wild
             const match = latestLog.match(/\.\.\.and it was a playable (.+?)!/);
             if (match) {
                 message = `...and auto-played ${match[1]}! Next: ${nextPlayerName}`;
             }
        } else if (latestLog.includes('drew') && latestLog.includes('cards.')) {
             message = `${latestLog.replace('› ', '').replace('.', '')}. Next: ${nextPlayerName}`;
        } else {
             // General fallback, remove markers
             message = latestLog.replace(/^› |^📣 |^🎨 |^✨ |^🤝 |^🌪️ |^🚨 / , '');
        }

        if (message) {
            showToast(message); // Call the main toast function
        }
    }
    
    function showWinnerAnnouncement(mainText, subText, duration) { /* ... (unchanged) ... */ const overlay = document.getElementById('winner-announcement-overlay'); const textElement = document.getElementById('winner-announcement-text'); const subtextElement = document.getElementById('winner-announcement-subtext'); if (!overlay || !textElement || !subtextElement) return; textElement.textContent = mainText; subtextElement.textContent = subText || ''; overlay.classList.remove('hidden'); startRainAnimation(); if (duration) { setTimeout(() => { hideWinnerAnnouncement(); }, duration); } }
    function hideWinnerAnnouncement() { /* ... (unchanged) ... */ const overlay = document.getElementById('winner-announcement-overlay'); if (overlay) overlay.classList.add('hidden'); stopRainAnimation(); }
    function startRainAnimation() { /* ... (unchanged) ... */ const container = document.getElementById('winner-animation-container'); if (!container || rainInterval) return; const elements = ['⭐', '🌸', '✨', '🎉', '🌟', '❤️', '💚', '💙', '💛']; rainInterval = setInterval(() => { if (!container) return; const rainElement = document.createElement('div'); rainElement.classList.add('rain-element'); rainElement.textContent = elements[Math.floor(Math.random() * elements.length)]; rainElement.style.left = Math.random() * 100 + 'vw'; rainElement.style.animationDuration = (Math.random() * 2 + 3) + 's'; rainElement.style.fontSize = (Math.random() * 1 + 1) + 'em'; container.appendChild(rainElement); setTimeout(() => { rainElement.remove(); }, 5000); }, 100); }
    function stopRainAnimation() { /* ... (unchanged) ... */ const container = document.getElementById('winner-animation-container'); if (rainInterval) { clearInterval(rainInterval); rainInterval = null; } if (container) { container.innerHTML = ''; } }
    
});